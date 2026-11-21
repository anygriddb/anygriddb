/**
 * What the operator's allow list leaves of what is declared, for
 * Administration → Sources: emptying it, or taking a host off it, is not
 * silent.
 */
import { isHomeTable } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { liveBase, liveTable } from "../data/live.js";
import type { SourceSettings } from "./types.js";

/** The hosts of a source a connection needs. */
type SourceHosts = {
  host: string;
  replicaHost?: string | null;
  replicaPort?: number | null;
};

/**
 * Whether a source can be reached: a replica off the list refuses the
 * whole source (`SourcePools`), as its primary would.
 */
export function sourceReachable(
  allows: SourceSettings["allows"],
  source: SourceHosts,
): boolean {
  return (
    allows(source.host) &&
    (!source.replicaHost || !source.replicaPort || allows(source.replicaHost))
  );
}

export type SourceImpact = {
  sources: number;
  /** Declared sources a host of which is outside the allow list. */
  blockedSources: number;
  /** Tables read where they live, those of a base held in a source apart. */
  liveTables: number;
  /** Tables read from a copy (ADR 0034 / 0088). */
  syncedTables: number;
  /** Bases whose tables live in a source schema (ADR 0090). */
  hostedBases: number;
  /** Of the tables, those a blocked source leaves with nothing to read. */
  unreachableTables: number;
  /** Of the synced tables, those a blocked source leaves on their last copy. */
  frozenTables: number;
  /** Of the hosted bases, those in a blocked source. */
  unreachableBases: number;
};

/** Pure summary: tests feed rows; the DB loader calls this. */
export function summarizeSourceImpact(input: {
  sources: ReadonlyArray<SourceHosts & { id: string }>;
  tables: ReadonlyArray<{
    sourceId: string;
    synced: boolean;
    /** A first copy has arrived: until then a synced table is read live. */
    hasCopy: boolean;
    hosted: boolean;
  }>;
  hostedBases: ReadonlyArray<{ sourceId: string }>;
  allows: SourceSettings["allows"];
}): SourceImpact {
  const blocked = new Set(
    input.sources
      .filter((source) => !sourceReachable(input.allows, source))
      .map((source) => source.id),
  );
  const own = input.tables.filter((table) => !table.hosted);
  const cut = own.filter((table) => blocked.has(table.sourceId));
  return {
    sources: input.sources.length,
    blockedSources: blocked.size,
    liveTables: own.filter((table) => !table.synced).length,
    syncedTables: own.filter((table) => table.synced).length,
    hostedBases: input.hostedBases.length,
    unreachableTables: cut.filter((table) => !table.hasCopy).length,
    frozenTables: cut.filter((table) => table.hasCopy).length,
    unreachableBases: input.hostedBases.filter((base) =>
      blocked.has(base.sourceId),
    ).length,
  };
}

/** Impact of the current allow list on what is already declared. */
export async function sourceImpact(
  db: Database,
  settings: SourceSettings,
): Promise<SourceImpact> {
  const sources = await db
    .selectFrom("sources")
    .select(["id", "host", "replicaHost", "replicaPort"])
    .execute();
  // A table of a base in the trash is in no one's way: it is not counted.
  const tables = await db
    .selectFrom("dataTables as t")
    .innerJoin("bases as b", "b.id", "t.baseId")
    .leftJoin("externalSyncs as y", "y.tableId", "t.id")
    .select([
      "t.sourceId",
      "t.storage",
      "t.physicalName",
      "y.tableId as syncTableId",
      "y.syncedAt",
    ])
    .where("t.sourceId", "is not", null)
    .where(liveTable("t"))
    .where(liveBase("b"))
    .execute();
  const hostedBases = await db
    .selectFrom("bases")
    .select("homeSourceId")
    .where("homeSourceId", "is not", null)
    .where(liveBase())
    .execute();
  return summarizeSourceImpact({
    sources,
    tables: tables.map((table) => ({
      sourceId: table.sourceId ?? "",
      synced: table.syncTableId !== null,
      hasCopy: table.syncedAt !== null,
      hosted: isHomeTable(table),
    })),
    hostedBases: hostedBases.map((base) => ({
      sourceId: base.homeSourceId ?? "",
    })),
    allows: (host) => settings.allows(host),
  });
}
