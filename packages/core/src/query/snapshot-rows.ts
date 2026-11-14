/**
 * A base snapshot's rows, line by line (ADR 0076): read out of a table a
 * range of sequence numbers at a time, and written back keeping their
 * number, which pairs each row with the links that name it. No map of old
 * ids to new ones is held anywhere.
 */
import { AppError } from "../errors";
import { assertIdentifier, quoteIdent, type ParameterizedSql } from "./params";
import { MAX_READ_LIMIT } from "./read";

const SEQ = /^\d{1,19}$/;
const ROW_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most pairs one statement links: well inside the pool's time limit. */
export const MAX_SNAPSHOT_LINK_PAIRS = 5_000;

function assertSeqs(values: readonly string[]): void {
  for (const value of values) {
    if (!SEQ.test(value)) throw new AppError("invalid_snapshot");
  }
}

function assertPairs(fromSeqs: readonly string[], toSeqs: readonly string[]) {
  if (
    fromSeqs.length === 0 ||
    fromSeqs.length !== toSeqs.length ||
    fromSeqs.length > MAX_SNAPSHOT_LINK_PAIRS
  ) {
    throw new AppError("invalid_limit");
  }
  assertSeqs(fromSeqs);
  assertSeqs(toSeqs);
}

/**
 * The next rows of a table past `after`, by sequence number: each one's id,
 * number, and place. A snapshot reads a table this way so that a row is
 * written once, whatever is added or removed while it reads.
 */
export function buildSnapshotKeys(input: {
  table: string;
  after: string;
  limit: number;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertSeqs([input.after]);
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_READ_LIMIT
  ) {
    throw new AppError("invalid_limit");
  }
  return {
    text: `select "id", "ag_seq"::text as "seq", "ag_position"::text as "position" from ${quoteIdent(input.table)} where "ag_seq" > $1::bigint order by "ag_seq" limit $2`,
    values: [input.after, input.limit],
  };
}

/** The sequence numbers of some rows of a table, by their ids. */
export function buildRowSeqs(input: {
  table: string;
  ids: readonly string[];
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  if (input.ids.length === 0 || input.ids.length > MAX_SNAPSHOT_LINK_PAIRS) {
    throw new AppError("invalid_limit");
  }
  for (const id of input.ids) {
    if (!ROW_ID.test(id)) throw new AppError("invalid_row_id");
  }
  return {
    text: `select "id", "ag_seq"::text as "seq" from ${quoteIdent(input.table)} where "id" = any($1::uuid[])`,
    values: [[...input.ids]],
  };
}

/**
 * Moves the sequence that places new rows past the highest place of a
 * table's rows, so that a row added after a snapshot is read in goes after
 * them: the snapshot keeps the places of the instance it came from.
 */
export function buildPositionsAfter(input: {
  table: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  return {
    text: `select setval('ag_row_position', ceil(s."top")::bigint) from (select max("ag_position") as "top" from ${quoteIdent(input.table)}) s where ceil(s."top") > (select "last_value" from ag_row_position)`,
    values: [],
  };
}

/**
 * Points rows of `from` at rows of `to` through a one-to-many link, by
 * sequence number: `fromSeqs[i]` links to `toSeqs[i]`. The table's trigger
 * records each change. A number that names no row links nothing.
 */
export function buildSnapshotForeignKeys(input: {
  from: string;
  to: string;
  /** The link's foreign key, on `from`. */
  column: string;
  fromSeqs: readonly string[];
  toSeqs: readonly string[];
}): ParameterizedSql {
  assertIdentifier(input.from, "table name");
  assertIdentifier(input.to, "table name");
  assertIdentifier(input.column, "column name");
  assertPairs(input.fromSeqs, input.toSeqs);
  const from = quoteIdent(input.from);
  const to = quoteIdent(input.to);
  return {
    text: `update ${from} s set ${quoteIdent(input.column)} = t."id" from unnest($1::bigint[], $2::bigint[]) as p ("from_seq", "to_seq") join ${to} t on t."ag_seq" = p."to_seq" where s."ag_seq" = p."from_seq"`,
    values: [[...input.fromSeqs], [...input.toSeqs]],
  };
}

/**
 * Links rows of `from` to rows of `to` through a many-to-many junction, by
 * sequence number, and records each linked row's links in the trail as one
 * change of its field, as a person setting them would. A pair already
 * there, or a number that names no row, adds nothing.
 */
export function buildSnapshotJunction(input: {
  from: string;
  to: string;
  junction: string;
  /** The link field, as the trail names it. */
  field: string;
  userId: string;
  tableId: string;
  fromSeqs: readonly string[];
  toSeqs: readonly string[];
}): ParameterizedSql {
  for (const table of [input.from, input.to, input.junction]) {
    assertIdentifier(table, "table name");
  }
  assertIdentifier(input.field, "column name");
  assertPairs(input.fromSeqs, input.toSeqs);
  for (const id of [input.userId, input.tableId]) {
    if (!ROW_ID.test(id)) throw new AppError("invalid_body");
  }
  const from = quoteIdent(input.from);
  const to = quoteIdent(input.to);
  return {
    text: `with linked as (insert into ${quoteIdent(input.junction)} ("left_id", "right_id") select s."id", t."id" from unnest($1::bigint[], $2::bigint[]) as p ("from_seq", "to_seq") join ${from} s on s."ag_seq" = p."from_seq" join ${to} t on t."ag_seq" = p."to_seq" on conflict do nothing returning "left_id", "right_id") insert into "audit_events" ("user_id", "action", "table_id", "record_id", "old_value", "new_value", "source") select $3::uuid, 'update', $4::uuid, l."left_id", jsonb_build_object($5::text, '[]'::jsonb), jsonb_build_object($5::text, jsonb_agg(l."right_id" order by l."right_id")), 'snapshot' from linked l group by l."left_id"`,
    values: [
      [...input.fromSeqs],
      [...input.toSeqs],
      input.userId,
      input.tableId,
      input.field,
    ],
  };
}
