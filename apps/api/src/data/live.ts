import type { Database } from "@anygriddb/db";
import { sql, type RawBuilder } from "kysely";

/**
 * Rows outside the trash. Every read of the catalog goes through these.
 * Each takes the alias its table has in the query.
 */
function live(reference: string): RawBuilder<boolean> {
  return sql<boolean>`${sql.ref(`${reference}.deletedAt`)} is null`;
}
export const liveBase = (alias = "bases") => live(alias);
export const liveTable = (alias = "dataTables") => live(alias);
export const liveColumn = (alias = "dataColumns") => live(alias);
export const liveView = (alias = "views") => live(alias);
export const liveFolder = (alias = "tableFolders") => live(alias);

/** Names of a table's fields in the trash: new fields must not take them. */
export async function trashedColumnNames(
  db: Database,
  tableId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom("dataColumns")
    .select("name")
    .where("tableId", "=", tableId)
    .where("deletedAt", "is not", null)
    .execute();
  return rows.map((row) => row.name);
}

/** Names of a table's fields outside the trash. */
export async function liveColumnNames(
  db: Database,
  tableId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("dataColumns")
    .select("name")
    .where("tableId", "=", tableId)
    .where(liveColumn())
    .execute();
  return new Set(rows.map((row) => row.name));
}
