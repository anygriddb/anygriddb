import type { MappedField, SourceEngine } from "@anygriddb/core";

/** What it takes to sign in to a source, the password in clear. */
export type SourceConnection = {
  engine: SourceEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tlsCa: string | null;
  /** Connect without TLS for this source (ADR 0139). */
  allowPlaintext: boolean;
  queryTimeoutMs: number;
};

/** What a connection check found. */
export type SourceCheck = {
  serverVersion: string;
  /** Set when a read replica was probed with the same save/test. */
  replicaServerVersion?: string | null;
};

/** The operator's rules for sources (ADR 0026, 0139). */
export type SourceSettings = {
  allows: (host: string) => boolean;
  /** The operator's list, for administrators to read. */
  allowedHosts: readonly string[];
  /**
   * Development only: force every source without TLS. Production refuses
   * the env flag; a production source opts in per row instead.
   */
  allowPlaintext: boolean;
};

/** True when this connection may skip TLS (env lab flag or per-source opt-in). */
export function connectionAllowsPlaintext(
  settings: Pick<SourceSettings, "allowPlaintext">,
  source: Pick<SourceConnection, "allowPlaintext">,
): boolean {
  return settings.allowPlaintext || source.allowPlaintext;
}

/** A table of a source, by what names it there. */
export type TableName = { schema: string; name: string };

/** Which tables one look at a source reads (`table-scope.ts`). */
export type TableScope = {
  /** These tables only: what asks for one table never reads a cut list. */
  only?: readonly TableName[];
  /** A piece of `schema.name`, whatever its case. */
  search?: string;
};

/** A source's tables, and whether there were more than a list keeps. */
export type SourceListing = { tables: SourceTable[]; truncated: boolean };

/** A table or view of a source, as its account sees it. */
export type SourceTable = {
  schema: string;
  name: string;
  kind: "table" | "view";
  comment: string | null;
  /** From the engine's statistics; null when it has none yet. */
  estimatedRows: number | null;
  /** Empty for a table without a primary key: it can be read, not edited. */
  primaryKey: string[];
  /** What the account may do, read from the engine's privileges. */
  privileges: { insert: boolean; update: boolean; delete: boolean };
  /** SQL Server: Change Tracking is on and the account may read it. */
  changeTracking?: boolean;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    comment: string | null;
    canUpdate: boolean;
    /**
     * A new row may give it a value: not one the engine fills itself (a
     * generated or computed column, an identity that refuses one, a
     * rowversion).
     */
    canInsert: boolean;
    field: MappedField;
  }>;
  foreignKeys: Array<{
    columns: string[];
    target: { schema: string; name: string };
    targetColumns: string[];
  }>;
};
