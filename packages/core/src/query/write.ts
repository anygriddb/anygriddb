import { assertCellValue, type CellColumn } from "../cell-values";
import {
  type FieldType,
  isRelationType,
  isWritableType,
  physicalSqlType,
} from "../field-types";
import { storedFromJson } from "./conversion";
import {
  assertIdentifier,
  quoteIdent,
  SqlParams,
  type ParameterizedSql,
} from "./params";
import { AppError } from "../errors";
import { compareCodeUnits } from "../text-order";
import { MAX_READ_LIMIT } from "./read";
import { FAR_ROW_NUMBER } from "./snapshot-rows";

export type WriteColumn = CellColumn & { name: string };

type Cell = string | number | boolean | null | readonly string[];

const ROW_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROW_STATUS = new Set(["draft", "submitted", "locked", "signed"]);

export const MAX_BATCH_ROWS = 500;

/** A row's place: a decimal, as PostgreSQL's numeric writes it. */
const POSITION = /^-?\d{1,19}(?:\.\d{1,16000})?$/;

/** A row's place, bound as the numeric it is. */
export function bindPosition(params: SqlParams, value: string): string {
  if (!POSITION.test(value)) {
    throw new AppError("invalid_place");
  }
  return `${params.bind(value)}::numeric`;
}

/** A row's sequence number, as `ag_seq` keeps it. */
const SEQ = /^[1-9]\d{0,18}$/;

/**
 * A sequence number a row keeps from where it came from (a snapshot), bound
 * as the bigint it is.
 */
function bindSeq(params: SqlParams, value: string): string {
  if (!SEQ.test(value)) {
    throw new AppError("invalid_body");
  }
  return `${params.bind(value)}::bigint`;
}

export function assertRowId(value: string): void {
  if (!ROW_ID.test(value)) {
    throw new AppError("invalid_row_id");
  }
}

/** When and by whom a row was written, as a copy of it keeps them. */
export type KeptRowStamp = {
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

const ROW_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const STAMP_FIELDS = [
  `"ag_created_at"`,
  `"ag_updated_at"`,
  `"ag_created_by"`,
  `"ag_updated_by"`,
];
const STAMP_ALIASES = [`"kc"`, `"ku"`, `"kb"`, `"kw"`];

/** A row's kept dates and authors, bound in the order of `STAMP_FIELDS`. */
function bindStamp(params: SqlParams, stamp: KeptRowStamp): string[] {
  if (
    !ROW_INSTANT.test(stamp.createdAt) ||
    !ROW_INSTANT.test(stamp.updatedAt)
  ) {
    throw new AppError("invalid_body");
  }
  const author = (value: string | null) => {
    if (value === null) return "null::uuid";
    assertRowId(value);
    return `${params.bind(value)}::uuid`;
  };
  return [
    `${params.bind(stamp.createdAt)}::timestamptz`,
    `${params.bind(stamp.updatedAt)}::timestamptz`,
    author(stamp.createdBy),
    author(stamp.updatedBy),
  ];
}

export function assertIdList(ids: readonly string[], max = 10_000): void {
  if (ids.length < 1 || ids.length > max) {
    throw new AppError("invalid_limit");
  }
  for (const id of ids) {
    assertRowId(id);
  }
}

/** Bound value for a column, cast to its SQL type. Arrays travel as JSON. */
function bindCell(params: SqlParams, column: WriteColumn, value: Cell): string {
  if (value === null) {
    return "null";
  }
  const sqlType = physicalSqlType(column.fieldType);
  if (Array.isArray(value)) {
    return `array(select jsonb_array_elements_text(${params.bind(JSON.stringify(value))}::text::jsonb))::${sqlType}`;
  }
  return `${params.bind(value)}::${sqlType}`;
}

function assignments(
  params: SqlParams,
  columns: readonly WriteColumn[],
  values: Readonly<Record<string, Cell>>,
  // A list of rows needs each null in its field's type: PostgreSQL would
  // read a column of bare nulls as text.
  options: { typedNulls?: boolean } = {},
): Array<{ name: string; sql: string }> {
  const keys = Object.keys(values);
  if (keys.length > 200) {
    throw new AppError("invalid_column_count");
  }
  const known = new Map(columns.map((column) => [column.name, column]));
  return keys.map((key) => {
    assertIdentifier(key, "column name");
    const column = known.get(key);
    if (!column) {
      throw new AppError("unknown_column", key);
    }
    if (isRelationType(column.fieldType)) {
      throw new AppError("invalid_relation");
    }
    const value = values[key] ?? null;
    assertCellValue(column, value);
    if (!isWritableType(column.fieldType)) {
      throw new AppError("invalid_column");
    }
    return {
      name: quoteIdent(key),
      sql:
        value === null && options.typedNulls
          ? `null::${physicalSqlType(column.fieldType)}`
          : bindCell(params, column, value),
    };
  });
}

export function buildInsert(input: {
  table: string;
  columns: readonly WriteColumn[];
  values: Readonly<Record<string, Cell>>;
  /** Where the row goes in the table's order (`row-order.ts`). */
  position?: string | undefined;
  /** The sequence number the row keeps; the sequence's next by default. */
  seq?: string | undefined;
  /** The dates and authors the row keeps, from a copy made here. */
  stamp?: KeptRowStamp | undefined;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  const params = new SqlParams();
  const assigned = assignments(params, input.columns, input.values);
  if (input.position !== undefined) {
    assigned.push({
      name: `"ag_position"`,
      sql: bindPosition(params, input.position),
    });
  }
  if (input.seq !== undefined) {
    assigned.push({ name: `"ag_seq"`, sql: bindSeq(params, input.seq) });
  }
  if (input.stamp) {
    bindStamp(params, input.stamp).forEach((sql, index) => {
      assigned.push({ name: STAMP_FIELDS[index] ?? "", sql });
    });
  }
  if (assigned.length === 0) {
    return {
      text: `insert into ${quoteIdent(input.table)} default values returning "id"`,
      values: [],
    };
  }
  return {
    text: `insert into ${quoteIdent(input.table)} (${assigned.map((item) => item.name).join(", ")}) values (${assigned.map((item) => item.sql).join(", ")}) returning "id"`,
    values: params.values,
  };
}

/**
 * The most bound values one INSERT of many rows carries: well under the
 * 65,535 the protocol allows a statement.
 */
const MAX_INSERT_PARAMS = 20_000;

/**
 * One INSERT for rows that all set the same fields. The rows go in, and
 * their ids come back, in the order given: the rows are numbered and the
 * INSERT reads them sorted, which is the order PostgreSQL then gives each
 * its id and its sequence number.
 */
export function buildInsertMany(input: {
  table: string;
  columns: readonly WriteColumn[];
  rows: ReadonlyArray<Readonly<Record<string, Cell>>>;
  /** Where each row goes in the table's order, one per row. */
  positions?: readonly string[] | undefined;
  /** The sequence number each row keeps, one per row. */
  seqs?: readonly string[] | undefined;
  /** The dates and authors each row keeps, one per row. */
  stamps?: readonly KeptRowStamp[] | undefined;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  const first = input.rows[0];
  if (!first || input.rows.length > MAX_BATCH_ROWS) {
    throw new AppError("invalid_limit");
  }
  const names = Object.keys(first);
  if (names.length === 0) {
    throw new AppError("no_columns");
  }
  const { positions, seqs, stamps } = input;
  if (positions && positions.length !== input.rows.length) {
    throw new AppError("invalid_place");
  }
  if (seqs && seqs.length !== input.rows.length) {
    throw new AppError("invalid_body");
  }
  if (stamps && stamps.length !== input.rows.length) {
    throw new AppError("invalid_body");
  }
  const params = new SqlParams();
  let fields: string[] = [];
  const tuples = input.rows.map((values, index) => {
    if (
      Object.keys(values).length !== names.length ||
      names.some((name) => !Object.hasOwn(values, name))
    ) {
      throw new AppError("invalid_column_count");
    }
    const assigned = assignments(
      params,
      input.columns,
      Object.fromEntries(names.map((name) => [name, values[name] ?? null])),
      { typedNulls: true },
    );
    fields = assigned.map((item) => item.name);
    const position = positions
      ? [bindPosition(params, positions[index] ?? "")]
      : [];
    const seq = seqs ? [bindSeq(params, seqs[index] ?? "")] : [];
    const stamp = stamps?.[index] ? bindStamp(params, stamps[index]) : [];
    return `(${[...assigned.map((item) => item.sql), ...position, ...seq, ...stamp, String(index)].join(", ")})`;
  });
  const aliases = names.map((_, index) => `"c${String(index)}"`);
  if (positions) {
    fields.push(`"ag_position"`);
    aliases.push(`"cp"`);
  }
  if (seqs) {
    fields.push(`"ag_seq"`);
    aliases.push(`"cs"`);
  }
  if (stamps) {
    fields.push(...STAMP_FIELDS);
    aliases.push(...STAMP_ALIASES);
  }
  return {
    text: `insert into ${quoteIdent(input.table)} (${fields.join(", ")}) select ${aliases.join(", ")} from (values ${tuples.join(", ")}) as r (${[...aliases, '"n"'].join(", ")}) order by "n" returning "id"`,
    values: params.values,
  };
}

/** The fields a row sets, whatever the order it names them in. */
function shapeOf(values: Readonly<Record<string, Cell>>): string {
  return Object.keys(values).sort(compareCodeUnits).join("\u0000");
}

/**
 * The INSERTs that write some rows, in their order. Rows that follow each
 * other and set the same fields share one statement, within the bound on
 * its values: an import of a thousand rows is a few statements, not a
 * thousand. `rows` says how many ids each statement gives back.
 */
export function buildInserts(input: {
  table: string;
  columns: readonly WriteColumn[];
  rows: ReadonlyArray<Readonly<Record<string, Cell>>>;
  /** Where each row goes in the table's order; the sequence's next by default. */
  positions?: readonly string[] | undefined;
  /** The sequence number each row keeps; the sequence's next by default. */
  seqs?: readonly string[] | undefined;
  /** The dates and authors each row keeps, from a copy made here. */
  stamps?: readonly KeptRowStamp[] | undefined;
}): Array<{ statement: ParameterizedSql; rows: number }> {
  const { table, columns, positions, seqs, stamps } = input;
  if (positions && positions.length !== input.rows.length) {
    throw new AppError("invalid_place");
  }
  if (seqs && seqs.length !== input.rows.length) {
    throw new AppError("invalid_body");
  }
  if (stamps && stamps.length !== input.rows.length) {
    throw new AppError("invalid_body");
  }
  const statements: Array<{ statement: ParameterizedSql; rows: number }> = [];
  let run: Array<Readonly<Record<string, Cell>>> = [];
  let start = 0;
  let shape = "";
  let bound = 0;
  const flush = () => {
    if (run.length === 0) return;
    const placed = positions?.slice(start, start + run.length);
    const numbered = seqs?.slice(start, start + run.length);
    const stamped = stamps?.slice(start, start + run.length);
    statements.push({
      statement:
        shape === ""
          ? // A row that sets nothing takes every default but its place.
            buildInsert({
              table,
              columns,
              values: {},
              position: placed?.[0],
              seq: numbered?.[0],
              stamp: stamped?.[0],
            })
          : buildInsertMany({
              table,
              columns,
              rows: run,
              positions: placed,
              seqs: numbered,
              stamps: stamped,
            }),
      rows: run.length,
    });
    start += run.length;
    run = [];
    bound = 0;
  };
  for (const values of input.rows) {
    const next = shapeOf(values);
    const cells =
      Object.values(values).filter((value) => value !== null).length +
      (positions ? 1 : 0) +
      (seqs ? 1 : 0) +
      (stamps ? STAMP_FIELDS.length : 0);
    if (
      next !== shape ||
      next === "" ||
      run.length >= MAX_BATCH_ROWS ||
      bound + cells > MAX_INSERT_PARAMS
    ) {
      flush();
    }
    shape = next;
    run.push(values);
    bound += cells;
  }
  flush();
  return statements;
}

export function buildUpdate(input: {
  table: string;
  columns: readonly WriteColumn[];
  id: string;
  values: Readonly<Record<string, Cell>>;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertRowId(input.id);
  const params = new SqlParams();
  const assigned = assignments(params, input.columns, input.values);
  if (assigned.length === 0) {
    throw new AppError("no_columns");
  }
  const id = params.bind(input.id);
  return {
    text: `update ${quoteIdent(input.table)} set ${assigned.map((item) => `${item.name} = ${item.sql}`).join(", ")} where "id" = ${id}::uuid returning "id"`,
    values: params.values,
  };
}

/** The locked row's columns, to compare with what the person still sees. */
export function buildReadCells(input: {
  table: string;
  id: string;
  columns: readonly string[];
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertRowId(input.id);
  if (input.columns.length < 1 || input.columns.length > 200) {
    throw new AppError("invalid_limit");
  }
  for (const column of input.columns) {
    assertIdentifier(column, "column name");
  }
  const params = new SqlParams();
  return {
    text: `select ${input.columns.map((column) => quoteIdent(column)).join(", ")} from ${quoteIdent(input.table)} where "id" = ${params.bind(input.id)}::uuid`,
    values: params.values,
  };
}

export function buildDelete(input: {
  table: string;
  id: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertRowId(input.id);
  return {
    text: `delete from ${quoteIdent(input.table)} where "id" = $1 returning "id"`,
    values: [input.id],
  };
}

export function buildReadStatus(input: {
  table: string;
  id: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertRowId(input.id);
  return {
    text: `select "ag_status" from ${quoteIdent(input.table)} where "id" = $1 for update`,
    values: [input.id],
  };
}

/**
 * Locks some rows and reads their statuses in one statement. The rows are
 * locked in the order of their ids, so two writers that take the same rows
 * never wait on each other in a circle.
 */
export function buildReadStatuses(input: {
  table: string;
  ids: readonly string[];
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdList(input.ids);
  const params = new SqlParams();
  return {
    text: `select "id", "ag_status" from ${quoteIdent(input.table)} where "id" = any(${params.bindTextArray(input.ids)}::uuid[]) order by "id" for update`,
    values: params.values,
  };
}

export function buildSetStatus(input: {
  table: string;
  id: string;
  status: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertRowId(input.id);
  if (!ROW_STATUS.has(input.status)) {
    throw new AppError("invalid_status");
  }
  return {
    text: `update ${quoteIdent(input.table)} set "ag_status" = $1 where "id" = $2 returning "id"`,
    values: [input.status, input.id],
  };
}

/**
 * What the `delete` events of the trail hold in these fields, as JSON a
 * reader can take without rounding anything: a number and a document as
 * their exact text, a list of names as it is.
 */
export function buildReadHeldCells(input: {
  events: readonly string[];
  columns: readonly string[];
}): ParameterizedSql {
  assertIdList(input.events);
  for (const name of input.columns) assertIdentifier(name, "column name");
  const params = new SqlParams();
  const events = params.bindTextArray(input.events);
  const names = params.bindTextArray(input.columns);
  return {
    text: `select e."id" as "event", (select jsonb_object_agg(c.k, case jsonb_typeof(c.v) when 'number' then to_jsonb(c.v #>> '{}') when 'object' then to_jsonb(c.v::text) when 'array' then case when exists (select 1 from jsonb_array_elements(c.v) i where jsonb_typeof(i) <> 'string') then to_jsonb(c.v::text) else c.v end else c.v end) from jsonb_each(e."old_value") c(k, v) where c.k = any(${names})) as "held" from "audit_events" e where e."id" = any(${events}::uuid[]) and e."action" = 'delete'`,
    values: params.values,
  };
}

/**
 * Re-inserts a deleted row from the `delete` event of the trail that kept
 * it (`old_value`), keeping its id, sequence number, place, and creation
 * stamp. It always comes back as a draft. Columns that no longer exist are
 * ignored; new ones stay null. `values` are its fields as they read now
 * (`restoredCell`), a number as its exact text.
 */
export function buildRestoreRow(input: {
  table: string;
  columns: ReadonlyArray<{ name: string; fieldType: FieldType }>;
  values: Readonly<Record<string, unknown>>;
  /** The row. */
  id: string;
  /** The event of the trail that holds it as it was deleted. */
  event: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertRowId(input.id);
  assertRowId(input.event);
  for (const column of input.columns) {
    assertIdentifier(column.name, "column name");
  }
  const list = [
    "id",
    "ag_seq",
    "ag_created_at",
    "ag_created_by",
    ...input.columns.map((column) => column.name),
    "ag_position",
  ]
    .map(quoteIdent)
    .join(", ");
  // A row deleted before rows had a place of their own stood at its
  // sequence number. A number or a place nothing can follow is not given
  // back: the row takes the next one.
  const seq = `(s."o" ->> 'ag_seq')::bigint`;
  const place = `coalesce((s."o" ->> 'ag_position')::numeric, (s."o" ->> 'ag_seq')::numeric)`;
  const row = [
    `(s."o" ->> 'id')::uuid`,
    `case when ${seq} <= ${FAR_ROW_NUMBER} then ${seq} else nextval(pg_get_serial_sequence('${quoteIdent(input.table)}', 'ag_seq')) end`,
    `(s."o" ->> 'ag_created_at')::timestamptz`,
    `(s."o" ->> 'ag_created_by')::uuid`,
    ...input.columns.map(({ name, fieldType }) =>
      storedFromJson(fieldType, `g."v" -> '${name}'`),
    ),
    `case when abs(${place}) <= ${FAR_ROW_NUMBER} then ${place} else nextval('ag_row_position') end`,
  ].join(", ");
  return {
    text: `with "held" as (select e."old_value" as "o" from "audit_events" e where e."id" = $1::uuid and e."record_id" = $2::uuid and e."action" = 'delete'), "given" as (select $3::text::jsonb as "v") insert into ${quoteIdent(input.table)} (${list}) select ${row} from "held" s cross join "given" g returning "id"`,
    values: [input.event, input.id, JSON.stringify(input.values)],
  };
}

export function buildExistingIds(input: {
  table: string;
  ids: readonly string[];
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdList(input.ids);
  return {
    text: `select "id" from ${quoteIdent(input.table)} where "id" = any(array(select jsonb_array_elements_text($1::text::jsonb)::uuid))`,
    values: [JSON.stringify(input.ids)],
  };
}

export function buildSetLink(input: {
  table: string;
  column: string;
  rowId: string;
  targetId: string | null;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  assertRowId(input.rowId);
  if (input.targetId !== null) {
    assertRowId(input.targetId);
  }
  return {
    text: `update ${quoteIdent(input.table)} set ${quoteIdent(input.column)} = $1 where "id" = $2 returning "id"`,
    values: [input.targetId, input.rowId],
  };
}

/** Inverse one-to-many: the rows of `table` whose foreign key points at `targetId`. */
export function buildReadReferencing(input: {
  table: string;
  column: string;
  targetId: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  assertRowId(input.targetId);
  return {
    text: `select "id", "ag_status" from ${quoteIdent(input.table)} where ${quoteIdent(input.column)} = $1 order by "id" for update`,
    values: [input.targetId],
  };
}

/** The rows of `table` that point at `targetId`, read without locking them. */
export function buildReadReferencingIds(input: {
  table: string;
  column: string;
  targetId: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  assertRowId(input.targetId);
  return {
    text: `select "id" from ${quoteIdent(input.table)} where ${quoteIdent(input.column)} = $1 order by "id"`,
    values: [input.targetId],
  };
}

/** Rows locked together, each with its status and the key it holds. */
export function buildReadHolders(input: {
  table: string;
  column: string;
  ids: readonly string[];
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  assertIdList(input.ids);
  const params = new SqlParams();
  return {
    text: `select "id", "ag_status", ${quoteIdent(input.column)} as "key" from ${quoteIdent(input.table)} where "id" = any(${params.bindTextArray(input.ids)}::uuid[]) order by "id" for update`,
    values: params.values,
  };
}

/** Sets one foreign key on several rows, or clears it, in one statement. */
export function buildSetForeignKeys(input: {
  table: string;
  column: string;
  ids: readonly string[];
  targetId: string | null;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  assertIdList(input.ids);
  if (input.targetId !== null) assertRowId(input.targetId);
  const params = new SqlParams();
  const target = params.bind(input.targetId);
  return {
    text: `update ${quoteIdent(input.table)} set ${quoteIdent(input.column)} = ${target}::uuid where "id" = any(${params.bindTextArray(input.ids)}::uuid[]) returning "id"`,
    values: params.values,
  };
}

export function buildClearLinks(input: {
  junction: string;
  side: "left_id" | "right_id";
  id: string;
}): ParameterizedSql {
  assertIdentifier(input.junction, "table name");
  assertRowId(input.id);
  return {
    text: `delete from ${quoteIdent(input.junction)} where "${input.side}" = $1`,
    values: [input.id],
  };
}

/** Takes some links of one row out of a junction. */
export function buildRemoveLinks(input: {
  junction: string;
  side: "left_id" | "right_id";
  id: string;
  ids: readonly string[];
}): ParameterizedSql {
  assertIdentifier(input.junction, "table name");
  assertRowId(input.id);
  assertIdList(input.ids);
  const far = input.side === "left_id" ? "right_id" : "left_id";
  const params = new SqlParams();
  const own = params.bind(input.id);
  return {
    text: `delete from ${quoteIdent(input.junction)} where "${input.side}" = ${own}::uuid and "${far}" = any(${params.bindTextArray(input.ids)}::uuid[])`,
    values: params.values,
  };
}

export function buildInsertLinks(input: {
  junction: string;
  leftIds: readonly string[];
  rightIds: readonly string[];
}): ParameterizedSql {
  assertIdentifier(input.junction, "table name");
  if (input.leftIds.length !== input.rightIds.length) {
    throw new AppError("invalid_link");
  }
  assertIdList(input.leftIds);
  assertIdList(input.rightIds);
  return {
    text: `insert into ${quoteIdent(input.junction)} ("left_id", "right_id") select l::uuid, r::uuid from unnest(array(select jsonb_array_elements_text($1::text::jsonb)), array(select jsonb_array_elements_text($2::text::jsonb))) as pairs(l, r) on conflict do nothing`,
    values: [JSON.stringify(input.leftIds), JSON.stringify(input.rightIds)],
  };
}

/** The links of several rows of one side of a junction, in one read. */
export function buildReadJunctionRows(input: {
  junction: string;
  side: "left_id" | "right_id";
  ids: readonly string[];
}): ParameterizedSql {
  assertIdentifier(input.junction, "table name");
  assertIdList(input.ids);
  const params = new SqlParams();
  return {
    text: `select "left_id", "right_id" from ${quoteIdent(input.junction)} where "${input.side}" = any(${params.bindTextArray(input.ids)}::uuid[])`,
    values: params.values,
  };
}

export function buildReadJunction(input: {
  junction: string;
  side: "left_id" | "right_id";
  id: string;
}): ParameterizedSql {
  assertIdentifier(input.junction, "table name");
  assertRowId(input.id);
  return {
    text: `select "left_id", "right_id" from ${quoteIdent(input.junction)} where "${input.side}" = $1`,
    values: [input.id],
  };
}

export function buildNonNullValues(input: {
  table: string;
  column: string;
  limit: number;
  offset?: number;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_READ_LIMIT
  ) {
    throw new AppError("invalid_limit");
  }
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError("invalid_limit");
  }
  return {
    text: `select ${quoteIdent(input.column)} as "value" from ${quoteIdent(input.table)} where ${quoteIdent(input.column)} is not null order by ctid limit $1 offset $2`,
    values: [input.limit, offset],
  };
}

export function buildCountLocked(table: string): ParameterizedSql {
  assertIdentifier(table, "table name");
  return {
    text: `select count(*)::int as "count" from ${quoteIdent(table)} where "ag_status" in ('locked', 'signed')`,
    values: [],
  };
}

/** Number of non-null values that would not survive a conversion. */
export function buildCountDuplicates(input: {
  table: string;
  column: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  return {
    text: `select count(*)::int as "count" from (select ${quoteIdent(input.column)} from ${quoteIdent(input.table)} where ${quoteIdent(input.column)} is not null group by 1 having count(*) > 1) d`,
    values: [],
  };
}

/** Renames a select option in the stored values. Runs under the row audit trigger. */
export function buildRenameOption(input: {
  table: string;
  column: string;
  multiple: boolean;
  from: string;
  to: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  const column = quoteIdent(input.column);
  return input.multiple
    ? {
        // Two options merged leave one in a cell, where the first of them was.
        text: `update ${quoteIdent(input.table)} set ${column} = (select array_agg(d.v order by d.at) from (select u.v, min(u.ord) as at from unnest(array_replace(${column}, $1::text, $2::text)) with ordinality as u(v, ord) group by u.v) d) where $1::text = any(${column})`,
        values: [input.from, input.to],
      }
    : {
        text: `update ${quoteIdent(input.table)} set ${column} = $2::text where ${column} = $1::text`,
        values: [input.from, input.to],
      };
}
