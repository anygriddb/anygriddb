/**
 * Client databases AnyGridDB reads (ADRs 0006, 0026). Each one signs in
 * with a dedicated account over verified TLS; administrators declare
 * them, and the password is written once and never read back.
 */
import { z } from "zod";
import { isTimeZone } from "./field-config";

/** The engines whose SQL the read engine compiles to: read where they live. */
export const SQL_SOURCE_ENGINES = [
  "postgres",
  "mysql",
  "mariadb",
  "sqlserver",
  "oracle",
  "sqlite",
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

export function isSqlSourceEngine(
  engine: string | null | undefined,
): engine is SqlSourceEngine {
  return (SQL_SOURCE_ENGINES as readonly string[]).includes(engine ?? "");
}

export const DEFAULT_SOURCE_PORTS: Record<SourceEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlserver: 1433,
  // TCPS: AnyGridDB reaches Oracle over verified TLS, which a listener of
  // its own serves, by convention here (1521 is the plaintext one).
  oracle: 2484,
  // SQLite is a file; the port is unused and kept at 1 for the schema.
  sqlite: 1,
  mongodb: 27017,
  opensearch: 9200,
};

/** A copy is refreshed this often unless an administrator says otherwise. */
export const DEFAULT_COPY_INTERVAL_MINUTES = 60;

const PEM = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/;

/** A host name or an IP address, as typed: no scheme, no port, no path. */
const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:[\]_-]+$/, "Invalid host")
  .transform((host) => host.replace(/^\[|\]$/g, "").toLowerCase());

const nameSchema = z.string().trim().min(1).max(100);

function allowsEmptySecret(engine: SourceEngine): boolean {
  return engine === "sqlite";
}

const sourceFields = z
  .object({
    name: nameSchema,
    engine: z.enum(SOURCE_ENGINES),
    host: hostSchema,
    port: z.number().int().min(1).max(65_535),
    /** Database name, file path, or index list. */
    database: z.string().trim().min(1).max(4_096),
    username: z.string().trim().max(128),
    password: z.string().max(1_024),
    /** A certificate authority, or the server's self-signed certificate. */
    tlsCa: z.string().trim().max(65_536).regex(PEM).nullable().optional(),
    connectionLimit: z.number().int().min(1).max(50).default(5),
    queryTimeoutMs: z.number().int().min(1_000).max(300_000).default(15_000),
    /** The zone of its dates without one, such as `timestamp` (ADR 0005). */
    timeZone: z.string().max(64).refine(isTimeZone).default("UTC"),
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
  })
  .strict();

function refineSourceSecrets(
  input: z.infer<typeof sourceFields>,
  ctx: z.RefinementCtx,
): void {
  if (!allowsEmptySecret(input.engine) && input.username.trim() === "") {
    ctx.addIssue({
      code: "custom",
      path: ["username"],
      message: "Username required",
    });
  }
  if (!allowsEmptySecret(input.engine) && input.password === "") {
    ctx.addIssue({
      code: "custom",
      path: ["password"],
      message: "Password required",
    });
  }
  if (input.engine === "sqlite" && input.database.includes("\0")) {
    ctx.addIssue({
      code: "custom",
      path: ["database"],
      message: "Invalid database path",
    });
  }
}

export const sourceInputSchema = sourceFields.superRefine(refineSourceSecrets);

export type SourceInput = z.infer<typeof sourceInputSchema>;

/** A change to a source; a missing password keeps the stored one. */
export const sourceUpdateSchema = sourceFields
  .partial()
  .extend({ id: z.uuid() })
  .strict()
  .superRefine((input, ctx) => {
    if (input.engine === undefined) return;
    if (
      !allowsEmptySecret(input.engine) &&
      input.username !== undefined &&
      input.username.trim() === ""
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["username"],
        message: "Username required",
      });
    }
    if (
      !allowsEmptySecret(input.engine) &&
      input.password !== undefined &&
      input.password === ""
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["password"],
        message: "Password required",
      });
    }
    if (
      input.engine === "sqlite" &&
      input.database !== undefined &&
      input.database.includes("\0")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["database"],
        message: "Invalid database path",
      });
    }
  });

export type SourceUpdate = z.infer<typeof sourceUpdateSchema>;
