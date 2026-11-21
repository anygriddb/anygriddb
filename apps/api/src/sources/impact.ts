/**
 * How many sources and dependent objects the operator's allow list touches.
 * Used by Administration → Sources so emptying ALLOWED_HOSTS is not silent.
 */
import type { Database } from "@anygriddb/db";
import type { SourceSettings } from "./types.js";

/** Counts an administrator sees before the operator changes the allow list. */
export type SourceImpact = {
  sources: number;
  /** Declared sources whose host is outside the allow list. */
  blockedSources: number;
  /** Live or synced tables that point at a source. */
  exposedTables: number;
  /** Of those, tables read from a copy (ADR 0034 / 0088). */
  syncedTables: number;
  /** Of those, tables read live in the client's database. */
  liveTables: number;
  /** Bases whose tables live in a source schema (ADR 0090). */
  hostedBases: number;
};

/** Pure summary: tests feed rows; the DB loader calls this. */
export function summarizeSourceImpact(input: {
  sources: readonly { host: string }[];
  tables: readonly { synced: boolean }[];
  hostedBases: number;
  allows: (host: string) => boolean;
}): SourceImpact {
  const syncedTables = input.tables.filter((table) => table.synced).length;
  return {
    sources: input.sources.length,
    blockedSources: input.sources.filter((source) => !input.allows(source.host))
      .length,
    exposedTables: input.tables.length,
    syncedTables,
    liveTables: input.tables.length - syncedTables,
    hostedBases: input.hostedBases,
  };
}

/** Impact of the current allow list on what is already declared. */
export async function sourceImpact(
  db: Database,
  settings: SourceSettings,
): Promise<SourceImpact> {
  const sources = await db.selectFrom("sources").select(["host"]).execute();
  const tables = await db
    .selectFrom("dataTables as t")
    .leftJoin("externalSyncs as y", "y.tableId", "t.id")
    .select(["t.id", "y.tableId as syncTableId"])
    .where("t.sourceId", "is not", null)
    .where("t.deletedAt", "is", null)
    .execute();
  const hosted = await db
    .selectFrom("bases")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("homeSourceId", "is not", null)
    .where("deletedAt", "is", null)
    .executeTakeFirst();
  return summarizeSourceImpact({
    sources,
    tables: tables.map((table) => ({ synced: table.syncTableId !== null })),
    hostedBases: Number(hosted?.count ?? 0),
    allows: (host) => settings.allows(host),
  });
}
