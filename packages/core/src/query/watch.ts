/**
 * Changes other applications make in a client's table (ADRs 0006, 0031):
 * the statements a check runs in the client's engine.
 *
 * - **A column the database sets on every change**, a date and time
 *   (`updated_at`) or SQL Server's `rowversion`. A check reads the rows
 *   past where the last one stopped, in the column's order, then the key's
 *   to page past rows sharing a value. A date and time is set when a
 *   transaction writes, not when it commits: a check also reads again a
 *   short window behind, where a late commit lands. A `rowversion` stops
 *   short of the oldest open transaction's, so nothing lands behind it.
 * - **SQL Server's Change Tracking**, which the DBA enables: the rows
 *   added, changed, and deleted since a version, by their key.
 *
 * A row is named by its key as the read engine names it (`keyId`). Values
 * travel as the engine writes them as text and go back in the column's
 * own type. Placeholders are `$n`, as in reads.
 */
import { AppError } from "../errors";
import { dialectOf, type DialectName } from "./dialect";
import type { EngineTable } from "./engine";
import { quoteExternalIdent, SqlParams, type ParameterizedSql } from "./params";
import { tableSql } from "./storage";
import { withoutGroups } from "../plain-text";

/** How a column tells changes: by a date and time, or SQL Server's rowversion. */
type WatchKind = "time" | "version";

/** A client column a check reads: its name and declared type. */
export type WatchColumn = { name: string; type: string };

/** A declared type safe to write into SQL: `datetime2(3)`, `timestamp with time zone`. */
const SAFE_TYPE =
  /^[a-z][a-z0-9_]*(?: [a-z][a-z0-9_]*)*(?:\(\s*\d+\s*\))?(?: [a-z][a-z0-9_]*)*$/i;

function base(type: string): string {
  return withoutGroups(type.toLowerCase()).replace(/\s+/g, " ").trim();
}

const TIME_TYPES: Record<DialectName, ReadonlySet<string>> = {
  postgres: new Set([
    "timestamp with time zone",
    "timestamp without time zone",
    "timestamptz",
    "timestamp",
  ]),
  mysql: new Set(["datetime", "timestamp"]),
  mariadb: new Set(["datetime", "timestamp"]),
  sqlserver: new Set([
    "datetime",
    "datetime2",
    "smalldatetime",
    "datetimeoffset",
  ]),
  oracle: new Set([
    "timestamp",
    "timestamp with time zone",
    "timestamp with local time zone",
  ]),
};

/**
 * Whether a column can tell changes, and how: a date and time with a
 * time, or SQL Server's `rowversion` (`timestamp` there). Null otherwise.
 */
export function watchKind(
  dialect: DialectName,
  type: string,
): WatchKind | null {
  const name = base(type);
  if (
    dialect === "sqlserver" &&
    (name === "rowversion" || name === "timestamp")
  )
    return "version";
  return TIME_TYPES[dialect].has(name) ? "time" : null;
}

function external(table: EngineTable) {
  const found = table.external;
  if (!found) throw new AppError("internal_error", "native table");
  if (found.key.length === 0) throw new AppError("external_table_no_key");
  return found;
}

function declaredType(column: WatchColumn): string {
  const type = column.type.trim();
  if (type.length > 64 || !SAFE_TYPE.test(type)) {
    throw new AppError("source_watch_column");
  }
  return type;
}

function kindOf(table: EngineTable, column: WatchColumn): WatchKind {
  const kind = watchKind(external(table).dialect, column.type);
  if (!kind) throw new AppError("source_watch_column");
  return kind;
}

/** The column's value as text the engine reads back exactly. */
function markText(dialect: DialectName, kind: WatchKind, ref: string): string {
  if (kind === "version") {
    return `convert(varchar(18), cast(${ref} as binary(8)), 1)`;
  }
  switch (dialect) {
    case "postgres":
      // Sessions of a source read in UTC: an instant keeps its offset.
      return `(${ref})::text`;
    case "sqlserver":
      return `convert(varchar(40), ${ref}, 126)`;
    case "oracle":
      return `to_char(cast(${ref} as timestamp with time zone) at time zone '+00:00', 'YYYY-MM-DD"T"HH24:MI:SS.FF6TZH:TZM')`;
    default:
      return `cast(${ref} as char)`;
  }
}

/** A text value of the column, back in its own type. */
function markValue(
  dialect: DialectName,
  kind: WatchKind,
  column: WatchColumn,
  placeholder: string,
): string {
  if (kind === "version") return `convert(binary(8), ${placeholder}, 1)`;
  switch (dialect) {
    case "postgres":
      return `${placeholder}::${declaredType(column)}`;
    case "sqlserver":
      return `convert(${declaredType(column)}, ${placeholder}, 126)`;
    case "oracle":
      return `to_timestamp_tz(${placeholder}, 'YYYY-MM-DD"T"HH24:MI:SS.FF6TZH:TZM')`;
    default:
      // MySQL reads the text in the column's type, in the session's zone.
      return placeholder;
  }
}

/** `value` moved back by `seconds`. */
function behind(dialect: DialectName, value: string, seconds: number): string {
  const whole = String(Math.trunc(seconds));
  switch (dialect) {
    case "postgres":
      return `(${value} - interval '${whole} seconds')`;
    case "sqlserver":
      return `dateadd(second, -${whole}, ${value})`;
    case "oracle":
      return `(${value} - numtodsinterval(${whole}, 'SECOND'))`;
    default:
      return `(${value} - interval ${whole} second)`;
  }
}

/** A key column as text, and a text value back in its type. */
function keyText(dialect: DialectName, ref: string): string {
  switch (dialect) {
    case "postgres":
      return `(${ref})::text`;
    case "sqlserver":
      return `cast(${ref} as nvarchar(1000))`;
    case "oracle":
      return `cast(${ref} as varchar2(1000))`;
    default:
      return `cast(${ref} as char)`;
  }
}

function keyType(table: EngineTable, name: string): string | undefined {
  return table.columns.find((column) => column.physical?.name === name)
    ?.physical?.type;
}

/** SQL Server would compare a text key in the parameter's Unicode: cast it. */
function keyValue(
  dialect: DialectName,
  type: string | undefined,
  placeholder: string,
): string {
  if ((dialect !== "sqlserver" && dialect !== "oracle") || !type) {
    return placeholder;
  }
  const trimmed = type.trim();
  return /^[a-z][a-z0-9_]*(?:\(\s*(?:\d+|max)\s*(?:,\s*\d+\s*)?\))?$/i.test(
    trimmed,
  )
    ? `cast(${placeholder} as ${trimmed})`
    : placeholder;
}

/**
 * `(a, b) > (x, y)` written out, which SQL Server has no syntax for: the
 * rows after a key in the key's order.
 */
function after(refs: readonly string[], values: readonly string[]): string {
  const terms = refs.map((ref, index) => {
    const equal = refs
      .slice(0, index)
      .map((left, at) => `${left} = ${values[at] ?? ""}`);
    return [...equal, `${ref} > ${values[index] ?? ""}`].join(" and ");
  });
  return terms.map((term) => `(${term})`).join(" or ");
}

function limitClause(
  dialect: DialectName,
  limit: number,
  bind: (value: unknown) => string,
): string {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new AppError("invalid_limit");
  }
  return dialect === "sqlserver" || dialect === "oracle"
    ? ` offset 0 rows fetch next ${String(limit)} rows only`
    : dialect === "postgres"
      ? ` limit ${bind(limit)}`
      : ` limit ${String(limit)}`;
}

/** Where a check stands in the column's order: a value, and the key at it. */
type ColumnMark = { value: string; key: readonly string[] | null };

/**
 * Where a first check starts: the column's highest value, and the highest
 * key when it is one whole number (a row past it was added since).
 */
export function buildWatchStart(
  table: EngineTable,
  column: WatchColumn,
): ParameterizedSql {
  const { key, dialect } = external(table);
  const kind = kindOf(table, column);
  const ref = `t.${quoteExternalIdent(column.name)}`;
  const [only, ...more] = key;
  const top =
    only !== undefined && more.length === 0
      ? `, ${keyText(dialect, `max(t.${quoteExternalIdent(only)})`)}`
      : ", null";
  const settled =
    kind === "version" ? ` where ${ref} < min_active_rowversion()` : "";
  return {
    text: `select ${markText(dialect, kind, `max(${ref})`)} as "m"${top} as "top" from ${tableSql(table)} t${settled}`,
    values: [],
  };
}

/**
 * Rows past `mark` in the column's order, then the key's: `id`, the
 * column's value `m`, and the key's columns `k0`, `k1`, … to page on.
 */
export function buildWatchPage(
  table: EngineTable,
  column: WatchColumn,
  mark: ColumnMark | null,
  limit: number,
): ParameterizedSql {
  const { key, dialect } = external(table);
  const d = dialectOf(table);
  const kind = kindOf(table, column);
  const params = new SqlParams();
  const ref = `t.${quoteExternalIdent(column.name)}`;
  const keys = key.map((name) => `t.${quoteExternalIdent(name)}`);
  // No mark yet: the table was empty, every row is past it.
  let where = `${ref} is not null`;
  if (mark) {
    where = `${ref} > ${markValue(dialect, kind, column, params.bind(mark.value))}`;
  }
  if (mark?.key && mark.key.length === key.length) {
    const again = markValue(dialect, kind, column, params.bind(mark.value));
    const bound = key.map((name, index) =>
      keyValue(dialect, keyType(table, name), params.bind(mark.key?.[index])),
    );
    where = `(${where} or (${ref} = ${again} and (${after(keys, bound)})))`;
  }
  if (kind === "version") where += ` and ${ref} < min_active_rowversion()`;
  const columns = [
    `${d.keyId(keys)} as "id"`,
    `${markText(dialect, kind, ref)} as "m"`,
    ...keys.map(
      (sql, index) => `${keyText(dialect, sql)} as "k${String(index)}"`,
    ),
  ];
  return {
    text: `select ${columns.join(", ")} from ${tableSql(table)} t where ${where} order by ${[ref, ...keys].join(", ")}${limitClause(dialect, limit, (item) => params.bind(item))}`,
    values: params.values,
  };
}

/**
 * Rows whose value lies in the `seconds` before `at`, `at` included: where
 * a transaction that wrote before a check but committed after it lands.
 * A date and time only; a rowversion check never leaves one behind.
 */
export function buildWatchWindow(
  table: EngineTable,
  column: WatchColumn,
  at: string,
  seconds: number,
  limit: number,
): ParameterizedSql {
  const { key, dialect } = external(table);
  const d = dialectOf(table);
  const kind = kindOf(table, column);
  if (kind !== "time") throw new AppError("source_watch_column");
  const params = new SqlParams();
  const ref = `t.${quoteExternalIdent(column.name)}`;
  const keys = key.map((name) => `t.${quoteExternalIdent(name)}`);
  const from = behind(
    dialect,
    markValue(dialect, kind, column, params.bind(at)),
    seconds,
  );
  const to = markValue(dialect, kind, column, params.bind(at));
  return {
    text: `select ${d.keyId(keys)} as "id", ${markText(dialect, kind, ref)} as "m" from ${tableSql(table)} t where ${ref} > ${from} and ${ref} <= ${to} order by ${[ref, ...keys].join(", ")}${limitClause(dialect, limit, (item) => params.bind(item))}`,
    values: params.values,
  };
}

/** SQL Server's Change Tracking: the current version and the oldest kept. */
export function buildChangeVersion(table: EngineTable): ParameterizedSql {
  const { schema, name, dialect } = external(table);
  if (dialect !== "sqlserver") throw new AppError("source_watch_unavailable");
  return {
    text: `select cast(change_tracking_current_version() as varchar(20)) as "v", cast(change_tracking_min_valid_version(object_id(quotename($1) + '.' + quotename($2))) as varchar(20)) as "min"`,
    values: [schema, name],
  };
}

/** Where a Change Tracking check stands inside the changes it reads. */
type VersionMark = { version: string; key: readonly string[] };

/**
 * The rows changed since version `since` up to `upTo`, in version then key
 * order: `id`, the operation `op` (I, U, D), the version `v`, and the key's
 * columns `k0`, `k1`, … to page on. CHANGETABLE takes a variable only.
 */
export function buildChangeTracking(
  table: EngineTable,
  since: string,
  upTo: string,
  resume: VersionMark | null,
  limit: number,
): ParameterizedSql {
  const { key, dialect } = external(table);
  if (dialect !== "sqlserver") throw new AppError("source_watch_unavailable");
  const d = dialectOf(table);
  const params = new SqlParams();
  const keys = key.map((name) => `ct.${quoteExternalIdent(name)}`);
  const version = "ct.SYS_CHANGE_VERSION";
  let where = `${version} <= cast(${params.bind(upTo)} as bigint)`;
  if (resume && resume.key.length === key.length) {
    const at = `cast(${params.bind(resume.version)} as bigint)`;
    const again = `cast(${params.bind(resume.version)} as bigint)`;
    const bound = key.map((name, index) =>
      keyValue(dialect, keyType(table, name), params.bind(resume.key[index])),
    );
    where += ` and (${version} > ${at} or (${version} = ${again} and (${after(keys, bound)})))`;
  }
  const since$ = params.bind(since);
  const columns = [
    `${d.keyId(keys)} as "id"`,
    `ct.SYS_CHANGE_OPERATION as "op"`,
    `cast(${version} as varchar(20)) as "v"`,
    ...keys.map(
      (sql, index) => `${keyText(dialect, sql)} as "k${String(index)}"`,
    ),
  ];
  return {
    text: `declare @ag_since bigint = cast(${since$} as bigint); select ${columns.join(", ")} from changetable(changes ${tableSql(table)}, @ag_since) ct where ${where} order by ${[version, ...keys].join(", ")}${limitClause(dialect, limit, (item) => params.bind(item))}`,
    values: params.values,
  };
}
