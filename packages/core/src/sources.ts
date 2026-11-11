/**
 * Client databases AnyGridDB reads (ADRs 0006, 0026). Each one signs in
 * with a dedicated account over verified TLS; administrators declare
 * them, and the password is written once and never read back.
 */
import { z } from "zod";
import { isTimeZone } from "./field-config";

export const SOURCE_ENGINES = [
  "postgres",
  "mysql",
  "mariadb",
  "sqlserver",
  "oracle",
] as const;
export type SourceEngine = (typeof SOURCE_ENGINES)[number];

export const DEFAULT_SOURCE_PORTS: Record<SourceEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlserver: 1433,
  // TCPS: AnyGridDB reaches Oracle over verified TLS, which a listener of
  // its own serves, by convention here (1521 is the plaintext one).
  oracle: 2484,
};

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

export const sourceInputSchema = z
  .object({
    name: nameSchema,
    engine: z.enum(SOURCE_ENGINES),
    host: hostSchema,
    port: z.number().int().min(1).max(65_535),
    database: z.string().trim().min(1).max(128),
    username: z.string().trim().min(1).max(128),
    password: z.string().min(1).max(1_024),
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
    replicaDatabase: z.string().trim().min(1).max(128).nullable().optional(),
    replicaUsername: z.string().trim().min(1).max(128).nullable().optional(),
    /** Empty keeps the primary password when a replica host is set. */
    replicaPassword: z.string().max(1_024).nullable().optional(),
  })
  .strict();

export type SourceInput = z.infer<typeof sourceInputSchema>;

/** A change to a source; a missing password keeps the stored one. */
export const sourceUpdateSchema = sourceInputSchema
  .partial()
  .extend({ id: z.uuid() })
  .strict();

export type SourceUpdate = z.infer<typeof sourceUpdateSchema>;
