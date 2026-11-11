/**
 * Oracle Database as an external source (ADRs 0006, 0024, 0047): thin-mode
 * `node-oracledb` only, no Instant Client in the image, under Apache-2.0
 * (elected from the driver's Apache-2.0 OR UPL-1.0).
 */
import { AppError } from "@anygriddb/core";
import oracledb, { type Connection } from "oracledb";
import { issueClient, type Issued } from "../tls/certificate.js";
import type { SourceCheck, SourceConnection } from "./types.js";

/** Oracle 19c or later: the JSON functions and OFFSET … FETCH reads use. */
const MINIMUM_MAJOR = 19;

/** A service name: nothing that would end an address or add to it. */
const SERVICE = /^[A-Za-z0-9_][A-Za-z0-9_.$#-]{0,127}$/;

/**
 * Every session reads and writes as the dialect expects, whatever the
 * database's defaults: instants in UTC, a dot before decimals, English
 * names of days and months, text compared by code point, lengths in
 * characters. The territory first: it resets the others.
 */
const SESSION = [
  "alter session set nls_territory = 'AMERICA'",
  "nls_language = 'AMERICAN'",
  "time_zone = '+00:00'",
  "nls_numeric_characters = '.,'",
  "nls_date_format = 'YYYY-MM-DD HH24:MI:SS'",
  "nls_timestamp_format = 'YYYY-MM-DD HH24:MI:SS.FF6'",
  "nls_timestamp_tz_format = 'YYYY-MM-DD HH24:MI:SS.FF6 TZH:TZM'",
  "nls_sort = 'BINARY'",
  "nls_comp = 'BINARY'",
  "nls_length_semantics = 'CHAR'",
].join(" ");

export type OracleRow = Record<string, unknown>;

// NUMBER and CLOB as text: a read packs each row as JSON in a CLOB
// (`ag_row`), and exact decimals stay strings (ADR 0023).
oracledb.fetchAsString = [oracledb.NUMBER, oracledb.CLOB];

/**
 * Runs one statement; binds are positional (`:1`, `:2`, … in order). A
 * PL/SQL block's rows come back through DBMS_SQL.RETURN_RESULT.
 */
export async function oracleExecute(
  connection: Connection,
  text: string,
  values: readonly unknown[] = [],
): Promise<{ rows: OracleRow[]; affected: number }> {
  const result = await connection.execute<OracleRow>(text, [...values], {
    outFormat: oracledb.OUT_FORMAT_OBJECT,
    autoCommit: false,
  });
  const [returned] = (result.implicitResults ?? []) as OracleRow[][];
  return {
    rows: result.rows ?? returned ?? [],
    affected: result.rowsAffected ?? 0,
  };
}

export async function oracleQuery(
  connection: Connection,
  text: string,
  values: readonly unknown[] = [],
): Promise<OracleRow[]> {
  return (await oracleExecute(connection, text, values)).rows;
}

/** A column of a catalog row: Oracle names it in capitals unless quoted. */
export function rowValue(row: OracleRow | undefined, key: string): unknown {
  if (!row) return undefined;
  if (key in row) return row[key];
  const upper = key.toUpperCase();
  return upper in row ? row[upper] : undefined;
}

let identity: Issued | undefined;

/**
 * The thin driver takes trusted authorities only inside a wallet that
 * also holds a key: one made for this process, sent to no server that
 * does not ask for it, and the operator's authority (ADR 0026).
 */
function wallet(authority: string): string {
  identity ??= issueClient({ commonName: "AnyGridDB" });
  return `${identity.cert}${identity.key}${authority.trim()}\n`;
}

function address(source: SourceConnection, protocol: "tcp" | "tcps") {
  if (!SERVICE.test(source.database)) {
    throw new AppError("source_unknown_database");
  }
  const host = source.host.includes(":") ? `[${source.host}]` : source.host;
  return `${protocol}://${host}:${String(source.port)}/${source.database}`;
}

async function openThin(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<Connection> {
  if (!oracledb.thin) throw new AppError("source_unreachable", "thick");
  const common = {
    user: source.username,
    password: source.password,
    connectTimeout: 10,
  };
  // Verified TLS (ADR 0026); plaintext only under the development flag.
  if (!source.tlsCa) {
    if (!options.allowPlaintext) throw new AppError("source_tls_unavailable");
    return oracledb.getConnection({
      ...common,
      connectString: address(source, "tcp"),
    });
  }
  return oracledb.getConnection({
    ...common,
    connectString: address(source, "tcps"),
    walletContent: wallet(source.tlsCa),
    sslServerDNMatch: true,
  });
}

/**
 * Signs in the way every read does, and sets the session up. A DBA or
 * SYSDBA session is refused. The caller closes the connection.
 */
export async function connectOracle(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<{ connection: Connection; serverVersion: string }> {
  let connection: Connection | undefined;
  try {
    connection = await openThin(source, options);
    connection.callTimeout = source.queryTimeoutMs;
    await connection.execute(SESSION);
    // The release, from the sign-in itself: `23.26.0.0.0`.
    const serverVersion = connection.oracleServerVersionString;
    const major = Number(/^(\d+)\./.exec(serverVersion)?.[1] ?? 0);
    if (major < MINIMUM_MAJOR) {
      throw new AppError("source_version_unsupported", serverVersion);
    }
    const [privileges] = await oracleQuery(
      connection,
      `select
         case when exists (
           select 1 from session_roles where role in ('DBA', 'PDB_DBA')
         ) then 1 else 0 end as "dba",
         sys_context('USERENV', 'ISDBA') as "isdba"
       from dual`,
    );
    const isDba = rowValue(privileges, "isdba");
    if (
      Number(rowValue(privileges, "dba") ?? 0) === 1 ||
      (typeof isDba === "string" && isDba.toUpperCase() === "TRUE")
    ) {
      throw new AppError("source_admin_account");
    }
    return { connection, serverVersion };
  } catch (error) {
    await connection?.close().catch(() => undefined);
    throw oracleSourceError(error);
  }
}

export async function checkOracle(
  source: SourceConnection,
  options: { allowPlaintext: boolean },
): Promise<SourceCheck> {
  const { connection, serverVersion } = await connectOracle(source, options);
  await connection.close();
  return { serverVersion };
}

/** The number of an ORA- error, 0 for any other. */
export function oracleErrorNumber(error: unknown): number {
  if (error && typeof error === "object" && "errorNum" in error) {
    const number = Number(error.errorNum);
    if (Number.isFinite(number)) return number;
  }
  const message = error instanceof Error ? error.message : "";
  return Number(/ORA-(\d{5})/.exec(message)?.[1] ?? 0);
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") break;
    if ("code" in current) codes.push(String(current.code));
    current = "cause" in current ? current.cause : undefined;
  }
  return codes;
}

/** What went wrong signing in, as an administrator can fix it. */
export function oracleSourceError(raised: unknown): AppError {
  if (raised instanceof AppError) return raised;
  const number = oracleErrorNumber(raised);
  const message = raised instanceof Error ? raised.message : "";
  const codes = codesOf(raised);
  // Invalid credentials, or an account locked or expired.
  if (number === 1017 || number === 28000 || number === 28001) {
    return new AppError("source_auth_failed");
  }
  // Not open, unknown service.
  if (number === 1033 || number === 1034 || number === 12514) {
    return new AppError("source_unknown_database");
  }
  // DPI-1047: the thick client was asked for; it is not in the image.
  if (/DPI-1047/.test(message)) {
    return new AppError("source_unreachable", "thick");
  }
  // NJS-123: the call ran past callTimeout; ORA-01013: cancelled.
  if (number === 1013 || /NJS-123|call timeout/i.test(message)) {
    return new AppError("source_timeout");
  }
  // NJS-506 to 508: the handshake failed, the authority or the name did
  // not match.
  if (/NJS-50[678]|certificate|self[- ]signed|SSL|TLS/i.test(message)) {
    return new AppError("source_tls_failed");
  }
  const network = codes.find((code) => NETWORK_CODES.has(code));
  if (network) return new AppError("source_unreachable", network);
  if (/timeout|timed out/i.test(message)) return new AppError("source_timeout");
  return new AppError("source_unreachable");
}
