/**
 * Control-plane enrichment values (ADR 0046): fields AnyGridDB adds when
 * the source has no side schema. One JSON bag per client row.
 */
import { AppError, type EngineColumn } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Values keyed by field id for the given row ids. */
export async function loadEnrichmentValues(
  db: Database,
  tableId: string,
  rowIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (rowIds.length === 0) return out;
  const rows = await db
    .selectFrom("externalEnrichmentValues")
    .select(["rowId", "values"])
    .where("tableId", "=", tableId)
    .where("rowId", "in", [...rowIds])
    .execute();
  for (const row of rows) {
    out.set(row.rowId, row.values);
  }
  return out;
}

/**
 * Locks the rows' values until the transaction ends, making an empty bag
 * for a row that has none, so a write compares and changes them alone.
 */
export async function lockEnrichmentValues(
  db: Database,
  tableId: string,
  rowIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (rowIds.length === 0) return new Map();
  const ids = [...new Set(rowIds)];
  await db
    .insertInto("externalEnrichmentValues")
    .values(ids.map((rowId) => ({ tableId, rowId })))
    .onConflict((oc) => oc.columns(["tableId", "rowId"]).doNothing())
    .execute();
  const rows = await db
    .selectFrom("externalEnrichmentValues")
    .select(["rowId", "values"])
    .where("tableId", "=", tableId)
    .where("rowId", "in", ids)
    .orderBy("rowId")
    .forUpdate()
    .execute();
  return new Map(rows.map((row) => [row.rowId, row.values]));
}

/** A bag's values under the names of the fields asked for. */
export function enrichmentRow(
  bag: Record<string, unknown> | undefined,
  columns: readonly EngineColumn[],
  names: ReadonlySet<string>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    if (column.physical?.controlPlane && names.has(column.name)) {
      row[column.name] = bag?.[column.id] ?? null;
    }
  }
  return row;
}

/** Upsert field values for one row (null clears a field). */
export async function upsertEnrichmentValues(
  db: Database,
  input: {
    tableId: string;
    rowId: string;
    userId: string | null;
    patch: Record<string, unknown>;
  },
): Promise<void> {
  const keys = Object.keys(input.patch);
  if (keys.length === 0) return;
  await db
    .insertInto("externalEnrichmentValues")
    .values({
      tableId: input.tableId,
      rowId: input.rowId,
      values: input.patch,
      updatedBy: input.userId,
    })
    .onConflict((oc) =>
      oc.columns(["tableId", "rowId"]).doUpdateSet({
        values: sql`coalesce("external_enrichment_values"."values", '{}'::jsonb) || excluded.values`,
        updatedAt: sql`now()`,
        updatedBy: input.userId,
      }),
    )
    .execute();
}

/**
 * Row ids whose control-plane bag matches equality or blank on `fieldId`,
 * found in PostgreSQL to constrain a client read (ADR 0046). Text compares
 * without case, as a filter on any other text field does. More than
 * `limit` matching rows is refused: a client read takes at most that many
 * ids, and a filter is never silently cut.
 */
export async function enrichmentKeysMatching(
  db: Database,
  tableId: string,
  fieldId: string,
  match: { op: "eq" | "not_eq" | "blank" | "not_blank"; value?: unknown },
  limit: number,
): Promise<string[]> {
  const cell = sql`"values" -> ${fieldId}::text`;
  const text = sql`"values" ->> ${fieldId}::text`;
  const blank = sql<boolean>`(${cell} is null or jsonb_typeof(${cell}) = 'null' or ${text} = '' or ${cell} = '[]'::jsonb)`;
  const wanted = cellText(match.value);
  const predicate =
    match.op === "blank"
      ? blank
      : match.op === "not_blank"
        ? sql<boolean>`not ${blank}`
        : match.op === "eq"
          ? sql<boolean>`lower(${text}) = lower(${wanted})`
          : sql<boolean>`(${text} is null or lower(${text}) <> lower(${wanted}))`;
  const rows = await db
    .selectFrom("externalEnrichmentValues")
    .select("rowId")
    .where("tableId", "=", tableId)
    .where(predicate)
    .orderBy("rowId")
    .limit(limit + 1)
    .execute();
  if (rows.length > limit) throw new AppError("control_plane_filter_broad");
  return rows.map((row) => row.rowId);
}
