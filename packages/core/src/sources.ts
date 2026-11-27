/**
 * Client databases AnyGridDB reads (ADRs 0006, 0026, 0139). Each one signs
 * in with a dedicated account over verified TLS by default; an
 * administrator may opt one source into a clear connection after
 * confirming the risk. The password is written once and never read back.
 */
import { z } from "zod";
import { isTimeZone } from "./field-config";

/** The engines whose SQL the read engine compiles to: read where they live. */
const SQL_SOURCE_ENGINES = [
  "postgres",
  "mysql",
  "mariadb",
  "sqlserver",
  "oracle",
] as const;

/**
 * Stores that speak no SQL (ADR 0088). AnyGridDB lists what the account
 * may read and copies it on a schedule; every read goes to the copy, in
 * AnyGridDB's own database, and nothing is ever written to the store.
 */
const COPY_SOURCE_ENGINES = ["mongodb", "opensearch"] as const;

export const SOURCE_ENGINES = [
  ...SQL_SOURCE_ENGINES,
  ...COPY_SOURCE_ENGINES,
] as const;
export type SourceEngine = (typeof SOURCE_ENGINES)[number];
export type SqlSourceEngine = (typeof SQL_SOURCE_ENGINES)[number];
export type CopySourceEngine = (typeof COPY_SOURCE_ENGINES)[number];

/** What the form calls the field that names the database. */
export type SourceDatabaseField = "database" | "service" | "indices";

/**
 * The name of that field. A new store sets it here: the form does not
 * grow a case of its own for each engine.
 */
export function sourceDatabaseField(engine: SourceEngine): SourceDatabaseField {
  if (engine === "oracle") return "service";
  if (engine === "opensearch") return "indices";
  return "database";
}

/** True for a store read from a copy only. */
export function isCopySourceEngine(
  engine: string | null | undefined,
): engine is CopySourceEngine {
  return (COPY_SOURCE_ENGINES as readonly string[]).includes(engine ?? "");
}

export const DEFAULT_SOURCE_PORTS: Record<SourceEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlserver: 1433,
  // TCPS: AnyGridDB reaches Oracle over verified TLS, which a listener of
  // its own serves, by convention here (1521 is the plaintext one).
  oracle: 2484,
  mongodb: 27017,
  opensearch: 9200,
};

/** A copy is refreshed this often unless an administrator says otherwise. */
export const DEFAULT_COPY_INTERVAL_MINUTES = 60;

const PEM = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/;

/** A pasted PEM certificate authority or self-signed leaf. */
export const pemCertificateSchema = z.string().trim().max(65_536).regex(PEM);

/** A host name or an IP address, as typed: no scheme, no port, no path. */
export const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:[\]_-]+$/, "Invalid host")
  .transform((host) => host.replace(/^\[|\]$/g, "").toLowerCase());

const nameSchema = z.string().trim().min(1).max(100);

/**
 * A source's fields as one names them, none with a default: a change says
 * what it changes, and leaves the rest as stored.
 */
const sourceFields = {
  name: nameSchema,
  engine: z.enum(SOURCE_ENGINES),
  host: hostSchema,
  port: z.number().int().min(1).max(65_535),
  /** A database's name, a service's, or a list of indices. */
  database: z.string().trim().min(1).max(4_096),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1_024),
  /** A certificate authority, or the server's self-signed certificate. */
  tlsCa: pemCertificateSchema.nullable().optional(),
  /**
   * Connect without TLS (ADR 0139). Off unless asked; the administration
   * dialog confirms the risk before saving.
   */
  allowPlaintext: z.boolean(),
  connectionLimit: z.number().int().min(1).max(50),
  queryTimeoutMs: z.number().int().min(1_000).max(300_000),
  /** The zone of its dates without one, such as `timestamp` (ADR 0005). */
  timeZone: z.string().max(64).refine(isTimeZone),
  /**
   * The schema (a database on MySQL and MariaDB) its DBA gives AnyGridDB
   * for the fields it adds to the source's tables (ADR 0032).
   */
  sideSchema: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)
    .nullable()
    .optional(),
  /** Optional read replica: grid/API reads; writes stay on the primary. */
  replicaHost: hostSchema.nullable().optional(),
  replicaPort: z.number().int().min(1).max(65_535).nullable().optional(),
  replicaDatabase: z.string().trim().min(1).max(4_096).nullable().optional(),
  replicaUsername: z.string().trim().min(1).max(128).nullable().optional(),
  /** Empty keeps the primary password when a replica host is set. */
  replicaPassword: z.string().max(1_024).nullable().optional(),
};

/** A new source: what it leaves out takes its default. */
export const sourceInputSchema = z
  .object({
    ...sourceFields,
    allowPlaintext: sourceFields.allowPlaintext.default(false),
    connectionLimit: sourceFields.connectionLimit.default(5),
    queryTimeoutMs: sourceFields.queryTimeoutMs.default(15_000),
    timeZone: sourceFields.timeZone.default("UTC"),
  })
  .strict();

export type SourceInput = z.infer<typeof sourceInputSchema>;

/**
 * A change to a source: only what it names changes, a missing password
 * keeps the stored one. No default fills it in: one would put a setting
 * back, plaintext off on a source that speaks no TLS among them.
 */
export const sourceUpdateSchema = z
  .object(sourceFields)
  .partial()
  .extend({ id: z.uuid() })
  .strict();

export type SourceUpdate = z.infer<typeof sourceUpdateSchema>;
