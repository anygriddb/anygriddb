import { assertCellValue, type CellColumn } from "../cell-values";
import {
  isRelationType,
  isWritableType,
  physicalSqlType,
} from "../field-types";
import {
  assertIdentifier,
  quoteIdent,
  SqlParams,
  type ParameterizedSql,
} from "./params";
import { AppError } from "../errors";
import { MAX_READ_LIMIT } from "./read";

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

export function assertRowId(value: string): void {
  if (!ROW_ID.test(value)) {
    throw new AppError("invalid_row_id");
  }
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
export function bindCell(
  params: SqlParams,
  column: WriteColumn,
  value: Cell,
): string {
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
export const MAX_INSERT_PARAMS = 20_000;

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
  const positions = input.positions;
  if (positions && positions.length !== input.rows.length) {
    throw new AppError("invalid_place");
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
    return `(${[...assigned.map((item) => item.sql), ...position, String(index)].join(", ")})`;
  });
  const aliases = names.map((_, index) => `"c${String(index)}"`);
  if (positions) {
    fields.push(`"ag_position"`);
    aliases.push(`"cp"`);
  }
  return {
    text: `insert into ${quoteIdent(input.table)} (${fields.join(", ")}) select ${aliases.join(", ")} from (values ${tuples.join(", ")}) as r (${[...aliases, '"n"'].join(", ")}) order by "n" returning "id"`,
    values: params.values,
  };
}

/** The fields a row sets, whatever the order it names them in. */
function shapeOf(values: Readonly<Record<string, Cell>>): string {
  return Object.keys(values).sort().join("\u0000");
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
}): Array<{ statement: ParameterizedSql; rows: number }> {
  const { table, columns, positions } = input;
  if (positions && positions.length !== input.rows.length) {
    throw new AppError("invalid_place");
  }
  const statements: Array<{ statement: ParameterizedSql; rows: number }> = [];
  let run: Array<Readonly<Record<string, Cell>>> = [];
  let start = 0;
  let shape = "";
  let bound = 0;
  const flush = () => {
    if (run.length === 0) return;
    const placed = positions?.slice(start, start + run.length);
    statements.push({
      statement:
        shape === ""
          ? // A row that sets nothing takes every default but its place.
            buildInsert({ table, columns, values: {}, position: placed?.[0] })
          : buildInsertMany({ table, columns, rows: run, positions: placed }),
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
      (positions ? 1 : 0);
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
 * Re-inserts a deleted row from its audit snapshot (`old_value`), keeping
 * its id, sequence number, place, and creation stamp. It always comes back
 * as a draft. Columns that no longer exist are ignored; new ones stay null.
 */
export function buildRestoreRow(input: {
  table: string;
  columns: readonly string[];
  snapshot: Record<string, unknown>;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  const id = input.snapshot.id;
  if (typeof id !== "string") {
    throw new AppError("invalid_row_id");
  }
  assertRowId(id);
  const names = [
    "id",
    "ag_seq",
    "ag_created_at",
    "ag_created_by",
    ...input.columns,
  ];
  for (const name of names) {
    assertIdentifier(name, "column name");
  }
  const list = [...names, "ag_position"].map(quoteIdent).join(", ");
  // A row deleted before rows had a place of their own stood at its
  // sequence number.
  const source = [
    ...names.map((name) => `s.${quoteIdent(name)}`),
    `coalesce(s."ag_position", s."ag_seq")`,
  ].join(", ");
  return {
    text: `insert into ${quoteIdent(input.table)} (${list}) select ${source} from jsonb_populate_record(null::${quoteIdent(input.table)}, $1::text::jsonb) s returning "id"`,
    values: [JSON.stringify(input.snapshot)],
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
    text: `select "id", "ag_status" from ${quoteIdent(input.table)} where ${quoteIdent(input.column)} = $1 for update`,
    values: [input.targetId],
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

/** Distinct non-empty text values of a column, for building select options. */
export function buildDistinctText(input: {
  table: string;
  column: string;
  arrayColumn?: boolean;
  limit: number;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
    throw new AppError("invalid_limit");
  }
  const source = input.arrayColumn
    ? `select unnest(${quoteIdent(input.column)})::text as v from ${quoteIdent(input.table)}`
    : `select ${quoteIdent(input.column)}::text as v from ${quoteIdent(input.table)}`;
  return {
    text: `select distinct btrim(v) as "value" from (${source}) s where v is not null and btrim(v) <> '' order by 1 limit $1`,
    values: [input.limit],
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
        text: `update ${quoteIdent(input.table)} set ${column} = array_replace(${column}, $1::text, $2::text) where $1::text = any(${column})`,
        values: [input.from, input.to],
      }
    : {
        text: `update ${quoteIdent(input.table)} set ${column} = $2::text where ${column} = $1::text`,
        values: [input.from, input.to],
      };
}
