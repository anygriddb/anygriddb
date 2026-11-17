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
  queryTimeoutMs: number;
};

/** What a connection check found. */
export type SourceCheck = {
  serverVersion: string;
  /** Set when a read replica was probed with the same save/test. */
  replicaServerVersion?: string | null;
};

/** The operator's rules for sources (ADR 0026). */
export type SourceSettings = {
  allows: (host: string) => boolean;
  /** The operator's list, for administrators to read. */
  allowedHosts: readonly string[];
  /** Development only: connect without TLS. */
  allowPlaintext: boolean;
};

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
