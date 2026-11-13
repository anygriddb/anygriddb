/**
 * The order of AnyGridDB's own rows (ADR 0060). Each row has a place,
 * `ag_position`, apart from its sequence number, which never changes:
 * rows are read by place, then by sequence. A new row takes the next value
 * of `ag_row_position`, one sequence for every table, so it comes after
 * every row placed so far. Rows put just before or just after another take
 * numbers between that row's and its neighbour's, with as few decimals as
 * the gap needs (`ag_row_positions`, migration 0069): no other row moves.
 */
import { AppError } from "../errors";
import { assertIdentifier, quoteIdent, SqlParams } from "./params";
import type { ParameterizedSql } from "./params";
import {
  assertIdList,
  assertRowId,
  bindPosition,
  MAX_BATCH_ROWS,
} from "./write";

/** Just before a row, or just after it. */
export type RowPlace = { before: string } | { after: string };

/** The row a place names, and on which side of it. */
export function placeTarget(place: RowPlace): {
  rowId: string;
  side: "before" | "after";
} {
  return "before" in place
    ? { rowId: place.before, side: "before" }
    : { rowId: place.after, side: "after" };
}

/**
 * Holds the placing of rows in one table until the transaction ends: two
 * people who put a row in the same gap at once get two places, not one.
 */
export function buildOrderLock(table: string): ParameterizedSql {
  assertIdentifier(table, "table name");
  return {
    text: `select pg_advisory_xact_lock(hashtext($1))`,
    values: [`ag_order:${table}`],
  };
}

/**
 * `count` places, in order, beside the row the place names: between it and
 * the row before it, or between it and the row after it. With no row there,
 * whole numbers under the first row, or the sequence's next values after
 * the last. Nothing comes back when the named row does not exist.
 */
export function buildRowPlaces(input: {
  table: string;
  place: RowPlace;
  count: number;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  const { rowId, side } = placeTarget(input.place);
  assertRowId(rowId);
  if (
    !Number.isInteger(input.count) ||
    input.count < 1 ||
    input.count > MAX_BATCH_ROWS
  ) {
    throw new AppError("invalid_limit");
  }
  const table = quoteIdent(input.table);
  const before = side === "before";
  // The neighbour on that side, in the order rows are read.
  const neighbour = `(select n."ag_position" from ${table} n where (n."ag_position", n."ag_seq") ${before ? "<" : ">"} (x."ag_position", x."ag_seq") order by n."ag_position" ${before ? "desc" : "asc"}, n."ag_seq" ${before ? "desc" : "asc"} limit 1)`;
  const bounds = before
    ? `${neighbour}, x."ag_position"`
    : `x."ag_position", ${neighbour}`;
  return {
    text: `select ag_row_positions(${bounds}, $2::int)::text[] as "positions" from ${table} x where x."id" = $1::uuid`,
    values: [rowId, input.count],
  };
}

/**
 * Gives rows the places listed, in the order the rows had among
 * themselves: the first of them takes the first place.
 */
export function buildMoveRows(input: {
  table: string;
  rowIds: readonly string[];
  positions: readonly string[];
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdList(input.rowIds, MAX_BATCH_ROWS);
  if (
    input.positions.length !== input.rowIds.length ||
    new Set(input.rowIds.map((id) => id.toLowerCase())).size !==
      input.rowIds.length
  ) {
    throw new AppError("invalid_place");
  }
  const table = quoteIdent(input.table);
  const params = new SqlParams();
  const ids = params.bindTextArray(input.rowIds);
  const places = input.positions.map((value) => bindPosition(params, value));
  return {
    text: `update ${table} t set "ag_position" = p."position" from (select m."id", row_number() over (order by m."ag_position", m."ag_seq") as "n" from ${table} m where m."id" = any(${ids}::uuid[])) o join (values ${places.map((place, index) => `(${String(index + 1)}, ${place})`).join(", ")}) as p ("n", "position") on p."n" = o."n" where t."id" = o."id" returning t."id"`,
    values: params.values,
  };
}
