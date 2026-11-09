import { AppError } from "@anygriddb/core";
import pg from "pg";
import type { SourceCheck, SourceConnection } from "./types.js";

/**
 * Signs in to a PostgreSQL source the way every read does: verified TLS
 * (with the pasted certificate when there is one), the application name
 * AnyGridDB, and the source's time limit. A superuser is refused. The
 * caller ends the client.
 */
export async function connectPostgres(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<{ client: pg.Client; serverVersion: string }> {
  const client = new pg.Client({
    host: source.host,
    port: source.port,
    database: source.database,
    user: source.username,
    password: source.password,
    application_name: "AnyGridDB",
    connectionTimeoutMillis: 10_000,
    statement_timeout: source.queryTimeoutMs,
    query_timeout: source.queryTimeoutMs,
    // No switch turns verification off (ADR 0026): only the operator's
    // development flag connects without TLS at all.
    ssl: options.allowPlaintext
      ? false
      : { rejectUnauthorized: true, ca: source.tlsCa ?? undefined },
  });
  // A connection that drops reports through the query that waits on it.
  client.on("error", () => undefined);
  try {
    await client.connect();
    const { rows } = await client.query<{
      version: string;
      versionNumber: number;
      superuser: boolean;
    }>(
      `select current_setting('server_version') as version,
              current_setting('server_version_num')::int as "versionNumber",
              rolsuper as superuser
         from pg_roles where rolname = current_user`,
    );
    const row = rows[0];
    if (!row) throw new AppError("source_auth_failed");
    if (row.superuser) throw new AppError("source_admin_account");
    // The read engine needs PostgreSQL 13 (trim_scale, among others).
    if (row.versionNumber < 130_000) {
      throw new AppError("source_version_unsupported", row.version);
    }
    return { client, serverVersion: row.version };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw postgresSourceError(error);
  }
}

export async function checkPostgres(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<SourceCheck> {
  const { client, serverVersion } = await connectPostgres(source, options);
  await client.end().catch(() => undefined);
  return { serverVersion };
}

const TLS_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

/** What went wrong, as an administrator can fix it; never the raw text. */
export function postgresSourceError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "28P01" || code === "28000")
    return new AppError("source_auth_failed");
  if (code === "3D000") return new AppError("source_unknown_database");
  if (code === "57014" || /timeout/i.test(message))
    return new AppError("source_timeout");
  if (message.includes("does not support SSL"))
    return new AppError("source_tls_unavailable");
  if (code && (TLS_CODES.has(code) || code.startsWith("ERR_TLS")))
    return new AppError("source_tls_failed", code);
  if (code && NETWORK_CODES.has(code))
    return new AppError("source_unreachable", code);
  return new AppError("source_unreachable");
}
