import { AppError } from "@anygriddb/core";
import { Connection, Request, TYPES } from "tedious";
import type { SourceCheck, SourceConnection } from "./types.js";

/** SQL Server 2017 (14) or later: STRING_AGG, TRIM, and CONCAT_WS. */
const MINIMUM_MAJOR = 14;

type SqlServerRow = Record<string, unknown>;

/**
 * Runs one statement and returns its rows by column name. Parameters are
 * named `@p1`, `@p2`, … and bound as the type their value has: text, a
 * whole number, or a boolean.
 */
export async function sqlServerQuery(
  connection: Connection,
  text: string,
  values: readonly unknown[] = [],
): Promise<SqlServerRow[]> {
  return (await sqlServerExecute(connection, text, values)).rows;
}

/** As `sqlServerQuery`, with the number of rows the statement changed. */
export function sqlServerExecute(
  connection: Connection,
  text: string,
  values: readonly unknown[] = [],
): Promise<{ rows: SqlServerRow[]; affected: number }> {
  return new Promise((resolve, reject) => {
    const rows: SqlServerRow[] = [];
    const request = new Request(text, (error, rowCount) => {
      if (error) reject(error);
      else resolve({ rows, affected: rowCount ?? 0 });
    });
    for (const [index, value] of values.entries()) {
      const name = `p${String(index + 1)}`;
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        request.addParameter(name, TYPES.BigInt, value);
      } else if (typeof value === "boolean") {
        request.addParameter(name, TYPES.Bit, value);
      } else if (value === null || value === undefined) {
        request.addParameter(name, TYPES.NVarChar, null);
      } else {
        // The read engine binds text: numbers as decimal strings, lists
        // as JSON.
        const text = typeof value === "string" ? value : JSON.stringify(value);
        request.addParameter(name, TYPES.NVarChar, text, { length: Infinity });
      }
    }
    request.on(
      "row",
      (columns: Array<{ metadata: { colName: string }; value: unknown }>) => {
        const row: SqlServerRow = {};
        for (const column of columns) {
          row[column.metadata.colName] = column.value;
        }
        rows.push(row);
      },
    );
    connection.execSql(request);
  });
}

/**
 * How every connection to a SQL Server source signs in: TLS with the
 * certificate verified (the pasted one when there is one), the program
 * name AnyGridDB, UTC dates, and the source's time limit. A sysadmin, or
 * an account with CONTROL SERVER, is refused (ADR 0026).
 *
 * A connection, configured as every one to a source is, not yet open. */
export function sqlServerConnection(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Connection {
  return new Connection({
    server: source.host,
    authentication: {
      type: "default",
      options: { userName: source.username, password: source.password },
    },
    options: {
      port: source.port,
      database: source.database,
      appName: "AnyGridDB",
      connectTimeout: 10_000,
      requestTimeout: source.queryTimeoutMs,
      useUTC: true,
      // No switch turns verification off (ADR 0026): only the operator's
      // development flag connects without TLS at all.
      encrypt: !options.allowPlaintext,
      trustServerCertificate: false,
      ...(source.tlsCa
        ? { cryptoCredentialsDetails: { ca: source.tlsCa } }
        : {}),
    },
  });
}

/** Opens a connection; it reports a drop through the request waiting on it. */
export function openSqlServer(connection: Connection): Promise<void> {
  connection.on("error", () => undefined);
  return new Promise<void>((resolve, reject) => {
    connection.connect((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Signs in to a SQL Server source the way every read does, and checks the
 * account and the server. The caller closes the connection.
 */
export async function connectSqlServer(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<{ connection: Connection; serverVersion: string }> {
  const connection = sqlServerConnection(source, options);
  // The server says "Login failed" for a wrong password and an unknown
  // database alike; the message before it tells them apart (4060).
  const messages: number[] = [];
  connection.on("errorMessage", (token: { number: number }) => {
    messages.push(token.number);
  });
  try {
    await openSqlServer(connection);
    const [row] = await sqlServerQuery(
      connection,
      `select cast(serverproperty('ProductVersion') as nvarchar(128)) as version,
              cast(serverproperty('ProductMajorVersion') as int) as major,
              is_srvrolemember('sysadmin') as sysadmin,
              has_perms_by_name(null, null, 'CONTROL SERVER') as control`,
    );
    const version = typeof row?.version === "string" ? row.version : "";
    if (Number(row?.sysadmin) === 1 || Number(row?.control) === 1) {
      throw new AppError("source_admin_account");
    }
    if (Number(row?.major ?? 0) < MINIMUM_MAJOR) {
      throw new AppError("source_version_unsupported", version);
    }
    return { connection, serverVersion: version };
  } catch (error) {
    connection.close();
    if (messages.includes(4060)) throw new AppError("source_unknown_database");
    throw sqlServerSourceError(error);
  }
}

export async function checkSqlServer(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<SourceCheck> {
  const { connection, serverVersion } = await connectSqlServer(source, options);
  connection.close();
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

/** The code of an error, or of the error it wraps. */
function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth += 1
  ) {
    if ("code" in current) codes.push(String(current.code));
    current = "cause" in current ? current.cause : undefined;
  }
  return codes;
}

/**
 * The error SQL Server raised first. tedious gathers a request's errors in
 * an AggregateError: a refused statement is followed by 3621, "The
 * statement has been terminated", and the first one says why.
 */
export function firstSqlServerError(error: unknown): unknown {
  if (!(error instanceof AggregateError)) return error;
  const errors: unknown[] = error.errors;
  return (
    errors.find(
      (item) => item && typeof item === "object" && "number" in item,
    ) ??
    errors[0] ??
    error
  );
}

/** What went wrong, as an administrator can fix it; never the raw text. */
export function sqlServerSourceError(raised: unknown): AppError {
  if (raised instanceof AppError) return raised;
  const error = firstSqlServerError(raised);
  const codes = codesOf(error);
  const number =
    error && typeof error === "object" && "number" in error
      ? Number(error.number)
      : undefined;
  const message = error instanceof Error ? error.message : "";
  // 18456: login failed; 4060: cannot open the database.
  if (number === 18456 || codes.includes("ELOGIN")) {
    return /database/i.test(message) && /open/i.test(message)
      ? new AppError("source_unknown_database")
      : new AppError("source_auth_failed");
  }
  if (number === 4060) return new AppError("source_unknown_database");
  if (codes.includes("ETIMEOUT") && /request/i.test(message))
    return new AppError("source_timeout");
  const tls = codes.find(
    (code) => TLS_CODES.has(code) || code.startsWith("ERR_TLS"),
  );
  if (tls) return new AppError("source_tls_failed", tls);
  if (/certificate|self[- ]signed/i.test(message))
    return new AppError("source_tls_failed");
  if (/encrypt/i.test(message)) return new AppError("source_tls_unavailable");
  const network = codes.find((code) => NETWORK_CODES.has(code));
  if (network) return new AppError("source_unreachable", network);
  return new AppError("source_unreachable");
}
