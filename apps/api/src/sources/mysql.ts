import { AppError } from "@anygriddb/core";
import mysql from "mysql2/promise";
import type { SourceCheck, SourceConnection } from "./types.js";

/**
 * The oldest servers the read engine supports: window functions and
 * JSON_TABLE; on MySQL, derived tables that read the outer row and
 * LATERAL (8.0.14).
 */
const MINIMUM = { mysql: [8, 0, 14], mariadb: [10, 6, 0] } as const;

/**
 * Global privileges a dedicated account may hold on `*.*`: reading and
 * writing rows, and nothing that administers the server (ADR 0026).
 */
const ROW_PRIVILEGES = new Set([
  "USAGE",
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "SHOW VIEW",
  "SHOW DATABASES",
  "EXECUTE",
  "LOCK TABLES",
  "CREATE TEMPORARY TABLES",
]);

/**
 * True when grants make an account an administrator: a global grant with
 * the grant option, or of anything beyond rows (ALL, SUPER, CREATE USER,
 * FILE, PROCESS, a `*_ADMIN` privilege, DDL on every schema, …).
 */
export function isAdministrator(grants: readonly string[]): boolean {
  for (const line of grants) {
    const global = /^GRANT\s+(.+?)\s+ON\s+\*\.\*\s+TO\s/is.exec(line);
    if (!global) continue;
    if (/\bWITH\s+GRANT\s+OPTION\b/i.test(line)) return true;
    const privileges = (global[1] ?? "").split(",").map((item) =>
      item
        .trim()
        .replace(/\s*\(.*\)$/, "")
        .toUpperCase(),
    );
    if (privileges.some((item) => !ROW_PRIVILEGES.has(item))) return true;
  }
  return false;
}

/** `8.4.3` or `11.4.4-MariaDB-ubu2404`: which server, and is it recent enough. */
export function serverFlavor(version: string): {
  engine: "mysql" | "mariadb";
  supported: boolean;
} {
  const engine = /mariadb/i.test(version) ? "mariadb" : "mysql";
  const parts = version
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  const needed = MINIMUM[engine];
  // The first part that differs decides.
  const order = needed
    .map((need, index) => (parts[index] ?? 0) - need)
    .find((difference) => difference !== 0);
  return { engine, supported: (order ?? 0) >= 0 };
}

/**
 * Signs in to a MySQL or MariaDB source the way every read does: verified
 * TLS (with the pasted certificate when there is one), the program name
 * AnyGridDB, UTC for TIMESTAMP values, and exact numbers as text. The
 * account must not administer the server, the server must be the engine
 * the administrator chose, and recent enough. The caller ends it.
 */
export async function connectMysql(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<{ connection: mysql.Connection; serverVersion: string }> {
  let connection: mysql.Connection | undefined;
  try {
    connection = await mysql.createConnection({
      host: source.host,
      port: source.port,
      database: source.database,
      user: source.username,
      password: source.password,
      connectTimeout: 10_000,
      connectAttributes: { program_name: "AnyGridDB" },
      // No switch turns verification off (ADR 0026): only the operator's
      // development flag connects without TLS at all.
      ssl: options.allowPlaintext
        ? undefined
        : { rejectUnauthorized: true, ca: source.tlsCa ?? undefined },
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      dateStrings: true,
      timezone: "Z",
    });
    // A connection that drops reports through the query that waits on it.
    connection.on("error", () => undefined);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      "select version() as version, current_role() as roles, convert_tz('2000-01-01 00:00:00', '+00:00', 'Europe/Paris') is not null as zones",
    );
    const version = String(rows[0]?.version ?? "");
    const flavor = serverFlavor(version);
    if (flavor.engine !== source.engine) {
      throw new AppError("source_engine_mismatch", flavor.engine);
    }
    if (!flavor.supported) {
      throw new AppError("source_version_unsupported", version);
    }
    if (isAdministrator(await grantsOf(connection, flavor.engine, rows[0]))) {
      throw new AppError("source_admin_account");
    }
    // Named zones need the server's time zone tables (mysql_tzinfo_to_sql):
    // without them CONVERT_TZ is null, and dates would read blank.
    if (Number(rows[0]?.zones) !== 1) {
      throw new AppError("source_time_zones_missing");
    }
    return { connection, serverVersion: version };
  } catch (error) {
    await connection?.end().catch(() => undefined);
    throw mysqlSourceError(error);
  }
}

/** The account's grants, with those of its active roles. */
async function grantsOf(
  connection: mysql.Connection,
  engine: "mysql" | "mariadb",
  session: mysql.RowDataPacket | undefined,
): Promise<string[]> {
  const roles: unknown = session?.roles;
  // MariaDB lists the current role's grants with the user's own; MySQL
  // shows a role's only when asked to use it.
  const statement =
    engine === "mysql" && typeof roles === "string" && roles !== "NONE"
      ? `show grants for current_user() using ${roles}`
      : engine === "mysql"
        ? "show grants for current_user()"
        : "show grants";
  const [rows] = await connection.query<mysql.RowDataPacket[]>(statement);
  return rows.map((row) => String(Object.values(row)[0] ?? ""));
}

export async function checkMysql(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<SourceCheck> {
  const { connection, serverVersion } = await connectMysql(source, options);
  await connection.end().catch(() => undefined);
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
export function mysqlSourceError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  const message = error instanceof Error ? error.message : "";
  if (
    code === "ER_ACCESS_DENIED_ERROR" ||
    code === "ER_NOT_SUPPORTED_AUTH_MODE"
  )
    return new AppError("source_auth_failed");
  if (code === "ER_BAD_DB_ERROR" || code === "ER_DBACCESS_DENIED_ERROR")
    return new AppError("source_unknown_database");
  // MySQL's and MariaDB's statement time limits.
  if (code === "ER_QUERY_TIMEOUT" || code === "ER_STATEMENT_TIMEOUT")
    return new AppError("source_timeout");
  if (code === "HANDSHAKE_NO_SSL_SUPPORT" || /secure connection/i.test(message))
    return new AppError("source_tls_unavailable");
  // mysql2 reports a certificate it could not verify under its own code.
  if (code === "HANDSHAKE_SSL_ERROR")
    return new AppError("source_tls_failed", code);
  if (code && (TLS_CODES.has(code) || code.startsWith("ERR_TLS")))
    return new AppError("source_tls_failed", code);
  if (code && NETWORK_CODES.has(code))
    return new AppError("source_unreachable", code);
  return new AppError("source_unreachable");
}
