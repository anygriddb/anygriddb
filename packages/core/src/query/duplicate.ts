/**
 * A table copied with its rows inside the instance's own database (ADR
 * 0065): rows go from one table to the other in SQL, a range of sequence
 * numbers at a time, without leaving it. A copied row keeps its sequence
 * number, which pairs it with its source row: the links between the
 * copied rows are found through it.
 */
import { AppError } from "../errors";
import { assertIdentifier, quoteIdent, type ParameterizedSql } from "./params";

/** Rows one statement copies: each is a transaction of its own. */
export const DUPLICATE_CHUNK = 5_000;

const SEQ = /^\d{1,19}$/;

function assertSeq(value: string): void {
  if (!SEQ.test(value)) throw new AppError("invalid_body");
}

function names(values: readonly string[]): string[] {
  for (const value of values) assertIdentifier(value, "column name");
  return values.map(quoteIdent);
}

/**
 * Copies the next rows of `from`, by sequence number past `after`, into
 * `to`: a new id, the same sequence number and place, and each column's
 * value as it is, from its name in `from` to its name in `to`. Answers how
 * many it copied and the last sequence number.
 */
export function buildDuplicateRows(input: {
  from: string;
  to: string;
  columns: ReadonlyArray<{ from: string; to: string }>;
  after: string;
  limit: number;
}): ParameterizedSql {
  assertIdentifier(input.from, "table name");
  assertIdentifier(input.to, "table name");
  assertSeq(input.after);
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new AppError("invalid_limit");
  }
  const into = [
    `"id"`,
    `"ag_seq"`,
    `"ag_position"`,
    ...names(input.columns.map((column) => column.to)),
  ].join(", ");
  const values = [
    "ag_uuidv7()",
    `s."ag_seq"`,
    `s."ag_position"`,
    ...names(input.columns.map((column) => column.from)).map(
      (column) => `s.${column}`,
    ),
  ].join(", ");
  return {
    text: `with copied as (insert into ${quoteIdent(input.to)} (${into}) select ${values} from ${quoteIdent(input.from)} s where s."ag_seq" > $1::bigint order by s."ag_seq" limit $2 returning "ag_seq") select count(*)::int as "count", max("ag_seq")::text as "last" from copied`,
    values: [input.after, input.limit],
  };
}

/** Starts a table's sequence past `last`, the highest number it was given. */
export function buildSequenceAfter(input: {
  table: string;
  last: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertSeq(input.last);
  return {
    text: `select setval(pg_get_serial_sequence($1, 'ag_seq'), greatest($2::bigint, 1))`,
    values: [quoteIdent(input.table), input.last],
  };
}

/**
 * Points a copied row's link to another row of the same table at that
 * row's copy, for the rows in (`after`, `upto`] by sequence number.
 */
export function buildDuplicateSelfLinks(input: {
  from: string;
  to: string;
  /** The link's column in the source table. */
  fromColumn: string;
  /** The same link's column in the copy. */
  toColumn: string;
  after: string;
  upto: string;
}): ParameterizedSql {
  assertIdentifier(input.from, "table name");
  assertIdentifier(input.to, "table name");
  assertSeq(input.after);
  assertSeq(input.upto);
  const [fromColumn, toColumn] = names([input.fromColumn, input.toColumn]);
  const from = quoteIdent(input.from);
  const to = quoteIdent(input.to);
  return {
    text: `update ${to} d set ${toColumn ?? ""} = t."id" from ${from} s join ${from} r on r."id" = s.${fromColumn ?? ""} join ${to} t on t."ag_seq" = r."ag_seq" where s."ag_seq" = d."ag_seq" and d."ag_seq" > $1::bigint and d."ag_seq" <= $2::bigint`,
    values: [input.after, input.upto],
  };
}

/**
 * Copies the many-to-many links of the rows in (`after`, `upto`] into the
 * copy's junction, toward the same rows or, for a link from the table to
 * itself, toward their copies. Each copied row's links are recorded in
 * the trail as one change of its field, as a person setting them would.
 */
export function buildDuplicateJunction(input: {
  from: string;
  to: string;
  fromJunction: string;
  toJunction: string;
  /** The link leads from the table to itself. */
  self: boolean;
  /** The copy's link field, as the trail names it. */
  field: string;
  userId: string;
  tableId: string;
  after: string;
  upto: string;
}): ParameterizedSql {
  for (const table of [
    input.from,
    input.to,
    input.fromJunction,
    input.toJunction,
  ]) {
    assertIdentifier(table, "table name");
  }
  assertIdentifier(input.field, "column name");
  assertSeq(input.after);
  assertSeq(input.upto);
  const from = quoteIdent(input.from);
  const to = quoteIdent(input.to);
  const far = input.self ? `t."id"` : `j."right_id"`;
  const self = input.self
    ? ` join ${from} r on r."id" = j."right_id" join ${to} t on t."ag_seq" = r."ag_seq"`
    : "";
  return {
    text: `with linked as (insert into ${quoteIdent(input.toJunction)} ("left_id", "right_id") select d."id", ${far} from ${quoteIdent(input.fromJunction)} j join ${from} s on s."id" = j."left_id" join ${to} d on d."ag_seq" = s."ag_seq"${self} where s."ag_seq" > $1::bigint and s."ag_seq" <= $2::bigint returning "left_id", "right_id") insert into "audit_events" ("user_id", "action", "table_id", "record_id", "old_value", "new_value", "source") select $3::uuid, 'update', $4::uuid, l."left_id", jsonb_build_object($5::text, '[]'::jsonb), jsonb_build_object($5::text, jsonb_agg(l."right_id" order by l."right_id")), 'duplicate' from linked l group by l."left_id"`,
    values: [input.after, input.upto, input.userId, input.tableId, input.field],
  };
}
