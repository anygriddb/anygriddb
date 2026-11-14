/**
 * Writes to a client's table (ADRs 0006, 0007): the statements that lock
 * rows, change them, add them, and delete them, in the client's engine.
 *
 * A row is named by its key as the read engine names it (`keyId`): one
 * column's value as text, or several as JSON. A value is written in the
 * column's own type, the inverse of how the read engine reads it
 * (`readColumn`): an instant in UTC goes back to the zone a date and time
 * without one is stored in. Placeholders are `$n`, as in reads; each
 * engine's driver rewrites them.
 */
import type { CellValue } from "../cell-values";
import { numberToDecimal } from "../decimal";
import { AppError } from "../errors";
import { isTimeZone } from "../field-config";
import { dialectOf, type DialectName } from "./dialect";
import { windowsZone } from "./dialect-sqlserver";
import type { EngineColumn, EngineTable, PhysicalColumn } from "./engine";
import { parseIsoInstant } from "./iso-instant";
import { quoteExternalIdent, SqlParams, type ParameterizedSql } from "./params";
import { tableSql } from "./storage";
import { trimEndRun } from "../plain-text";

/** A client column, with where and how it is stored. */
export type StoredColumn = EngineColumn & { physical: PhysicalColumn };

export type ExternalValue = { column: StoredColumn; value: CellValue };

function external(table: EngineTable) {
  const found = table.external;
  if (!found) throw new AppError("internal_error", "native table");
  if (found.key.length === 0) throw new AppError("external_table_no_key");
  return found;
}

/** A JSON value of a key, as text; numbers keep the digits they were written with. */
type Scalar = string | null;

/**
 * The scalars of a JSON array or object, in order, without turning numbers
 * into floats: a `bigint` key past 2^53 keeps its digits.
 */
function jsonScalars(text: string): Array<{ name?: string; value: Scalar }> {
  let at = 0;
  const fail = (): never => {
    throw new AppError("invalid_row_id");
  };
  const space = () => {
    while (at < text.length && /\s/.test(text[at] ?? "")) at += 1;
  };
  const string = (): string => {
    const match = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(at));
    if (!match) return fail();
    at += match[0].length;
    return JSON.parse(match[0]) as string;
  };
  const scalar = (): Scalar => {
    space();
    if (text[at] === '"') return string();
    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/.exec(
      text.slice(at),
    );
    if (!match) return fail();
    at += match[0].length;
    return match[0] === "null" ? null : match[0];
  };
  space();
  const open = text[at];
  if (open !== "[" && open !== "{") return fail();
  const close = open === "[" ? "]" : "}";
  at += 1;
  const items: Array<{ name?: string; value: Scalar }> = [];
  space();
  if (text[at] === close) return fail();
  for (;;) {
    space();
    let name: string | undefined;
    if (open === "{") {
      name = string();
      space();
      if (text[at] !== ":") return fail();
      at += 1;
    }
    items.push({ ...(name === undefined ? {} : { name }), value: scalar() });
    space();
    if (text[at] === ",") {
      at += 1;
      continue;
    }
    if (text[at] !== close) return fail();
    at += 1;
    space();
    if (at !== text.length) return fail();
    return items;
  }
}

/**
 * The key values a row's id names, in key order: the inverse of the
 * dialect's `keyId`. One key column: the id itself. Several: a JSON array
 * (PostgreSQL, MySQL, MariaDB) or an object `{"k0": …}` (SQL Server).
 */
export function keyValues(table: EngineTable, id: string): string[] {
  const { key, dialect } = external(table);
  if (id.length === 0 || id.length > 1_000) {
    throw new AppError("invalid_row_id");
  }
  if (key.length === 1) return [id];
  const items = jsonScalars(id);
  const ordered =
    dialect === "sqlserver"
      ? key.map(
          (_, index) =>
            items.find((item) => item.name === `k${String(index)}`)?.value,
        )
      : items.map((item) => item.value);
  if (
    ordered.length !== key.length ||
    ordered.some((value) => value === null || value === undefined)
  ) {
    throw new AppError("invalid_row_id");
  }
  return ordered as string[];
}

/** A declared type safe to write into SQL: `decimal(14,2)`, `nvarchar(50)`. */
const SAFE_TYPE =
  /^[a-z][a-z0-9_]*(?: [a-z][a-z0-9_]*)*(?:\(\s*(?:\d+|max)\s*(?:,\s*\d+\s*)?\))?(?: unsigned)?$/i;

function declared(type: string | undefined): string | undefined {
  const trimmed = type?.trim();
  return trimmed && trimmed.length <= 64 && SAFE_TYPE.test(trimmed)
    ? trimmed
    : undefined;
}

function baseType(type: string): string {
  return type.toLowerCase().replace(/\(.*$/, "").replace(/\s+/g, " ").trim();
}

/**
 * A bound key value compared with its column. PostgreSQL and MySQL read
 * the text in the column's type; SQL Server would convert a text column to
 * the parameter's Unicode instead, so the parameter takes the column's type.
 */
function keyParam(
  dialect: DialectName,
  type: string | undefined,
  placeholder: string,
): string {
  const sqlType =
    dialect === "sqlserver" || dialect === "oracle"
      ? declared(type)
      : undefined;
  return sqlType ? `cast(${placeholder} as ${sqlType})` : placeholder;
}

function keyType(table: EngineTable, name: string): string | undefined {
  return table.columns.find((column) => column.physical?.name === name)
    ?.physical?.type;
}

/** `"k" = $1 and …`: the row a key names. */
function keyMatch(
  table: EngineTable,
  values: readonly string[],
  params: SqlParams,
  alias = "",
): string {
  const { key, dialect } = external(table);
  return key
    .map(
      (name, index) =>
        `${alias}${quoteExternalIdent(name)} = ${keyParam(dialect, keyType(table, name), params.bind(values[index]))}`,
    )
    .join(" and ");
}

/** Rows by their ids: `"k" in (…)` for one key column, else each key. */
function rowsMatch(
  table: EngineTable,
  ids: readonly string[],
  params: SqlParams,
): string {
  const { key, dialect } = external(table);
  const [single] = key;
  if (key.length === 1 && single !== undefined) {
    const type = keyType(table, single);
    return `${quoteExternalIdent(single)} in (${ids
      .map((id) => keyParam(dialect, type, params.bind(id)))
      .join(", ")})`;
  }
  return ids
    .map((id) => `(${keyMatch(table, keyValues(table, id), params)})`)
    .join(" or ");
}

const INTEGER =
  /^(?:tinyint|smallint|mediumint|int|integer|bigint|serial|bigserial|smallserial|int2|int4|int8|year)\b/i;

/** Oracle's NUMBER(p) and NUMBER(p,0), which round a fraction away. */
const ORACLE_INTEGER = /^number\(\s*\d+\s*(?:,\s*0\s*)?\)$/i;

/** `YYYY-MM-DD HH:MM:SS[.ffffff]` in UTC, from an instant. */
function utcTimestamp(value: string): string {
  const parsed = parseIsoInstant(value);
  if (!parsed) throw new AppError("invalid_cell");
  return parsed.timestamp;
}

function zoneName(zone: string): string {
  if (!isTimeZone(zone)) throw new AppError("invalid_input");
  return zone;
}

/** A number as an exact decimal string; a whole number for an integer column. */
function decimalOf(column: StoredColumn, value: CellValue): string {
  const text =
    typeof value === "number" ? numberToDecimal(value) : String(value);
  if (text === undefined) throw new AppError("invalid_cell");
  if (
    (INTEGER.test(column.physical.type) ||
      ORACLE_INTEGER.test(column.physical.type)) &&
    /\.\d*[1-9]/.test(text)
  ) {
    throw new AppError("source_value_invalid", column.label);
  }
  return text;
}

/** A value in its column's type, bound: the inverse of the read. */
function writeValue(
  dialect: DialectName,
  column: StoredColumn,
  value: CellValue,
  params: SqlParams,
): string {
  if (value === null) return "null";
  const { physical } = column;
  const type = baseType(physical.type);
  switch (column.fieldType) {
    case "boolean":
      if (typeof value !== "boolean") throw new AppError("invalid_cell");
      // MySQL's boolean is a tinyint; tedious binds a boolean as a bit.
      if (
        dialect === "mysql" ||
        dialect === "mariadb" ||
        dialect === "oracle"
      ) {
        return params.bind(value ? 1 : 0);
      }
      return dialect === "sqlserver"
        ? params.bind(value)
        : params.bind(value ? "true" : "false");
    case "number":
    case "rating":
      return params.bind(decimalOf(column, value));
    case "text":
    case "long_text":
    case "single_select":
    case "email":
    case "url":
    case "phone":
      if (typeof value !== "string") throw new AppError("invalid_cell");
      return params.bind(value);
    case "date":
      if (typeof value !== "string") throw new AppError("invalid_cell");
      // Oracle reads a bound text by the session's format, which has a time.
      return dialect === "oracle"
        ? `to_date(${params.bind(value)}, 'YYYY-MM-DD')`
        : params.bind(value);
    case "datetime": {
      if (typeof value !== "string") throw new AppError("invalid_cell");
      const utc = utcTimestamp(value);
      const zone = zoneName(physical.zone);
      if (dialect === "postgres") {
        const instant = `${params.bind(`${utc}Z`)}::timestamptz`;
        return type === "timestamp without time zone" || type === "timestamp"
          ? `(${instant} at time zone '${zone}')`
          : instant;
      }
      if (dialect === "sqlserver") {
        const instant = `cast(${params.bind(`${utc} +00:00`)} as datetimeoffset)`;
        if (type === "datetimeoffset") return instant;
        return zone === "UTC"
          ? `cast(${instant} as datetime2(7))`
          : `cast(${instant} at time zone '${windowsZone(zone)}' as datetime2(7))`;
      }
      if (dialect === "oracle") {
        const instant = `to_timestamp_tz(${params.bind(`${utc} +00:00`)}, 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')`;
        // `timestamp(6) with time zone`: the precision sits inside the name.
        const named = physical.type
          .toLowerCase()
          .replace(/\(\s*\d+\s*\)/g, "")
          .replace(/\s+/g, " ")
          .trim();
        return named === "timestamp with time zone" ||
          named === "timestamp with local time zone"
          ? instant
          : zone === "UTC"
            ? `cast(${instant} as timestamp(6))`
            : `cast(from_tz(cast(${instant} as timestamp), '+00:00') at time zone '${zone}' as timestamp(6))`;
      }
      // TIMESTAMP reads and writes in the session's zone, UTC; DATETIME
      // has none, and is stored in the source's.
      if (type === "datetime" && zone !== "UTC") {
        return `convert_tz(${params.bind(utc)}, '+00:00', '${zone}')`;
      }
      return params.bind(utc);
    }
    case "relation_one_to_many":
      // A link writes the client's own foreign key: the target's key.
      if (typeof value !== "string") throw new AppError("invalid_relation");
      return keyParam(dialect, physical.type, params.bind(value));
    default:
      throw new AppError("column_is_read_only", column.label);
  }
}

/**
 * Oracle has no lock timeout for a session: each lock says how long it
 * waits for a row another write holds, as long as the others do.
 */
const ORACLE_LOCK_WAIT_SECONDS = 10;

/** Locks the rows `where` keeps in `from` until the transaction ends. */
function lockRows(dialect: DialectName, from: string, where: string): string {
  switch (dialect) {
    case "sqlserver":
      return `select 1 as "locked" from ${from} with (updlock, holdlock, rowlock) where ${where}`;
    case "oracle":
      return `select 1 as "locked" from ${from} where ${where} for update wait ${String(ORACLE_LOCK_WAIT_SECONDS)}`;
    default:
      return `select 1 as "locked" from ${from} where ${where} for update`;
  }
}

/**
 * Locks rows until the write's transaction ends, so no one changes them
 * between the read that compares and the write. SQL Server holds an
 * update lock to the end of the transaction.
 */
export function buildExternalLock(
  table: EngineTable,
  ids: readonly string[],
): ParameterizedSql {
  const params = new SqlParams();
  const { dialect } = external(table);
  const where = rowsMatch(table, ids, params);
  return {
    text: lockRows(dialect, tableSql(table), where),
    values: params.values,
  };
}

function assignments(
  dialect: DialectName,
  values: readonly ExternalValue[],
  params: SqlParams,
): Array<{ name: string; sql: string }> {
  if (values.length > 200) throw new AppError("invalid_column_count");
  return values.map(({ column, value }) => ({
    name: quoteExternalIdent(column.physical.name),
    sql: writeValue(dialect, column, value, params),
  }));
}

export function buildExternalUpdate(
  table: EngineTable,
  id: string,
  values: readonly ExternalValue[],
): ParameterizedSql {
  const { dialect } = external(table);
  const params = new SqlParams();
  const set = assignments(dialect, values, params);
  if (set.length === 0) throw new AppError("no_columns");
  const where = keyMatch(table, keyValues(table, id), params);
  return {
    text: `update ${tableSql(table)} set ${set.map((item) => `${item.name} = ${item.sql}`).join(", ")} where ${where}`,
    values: params.values,
  };
}

export function buildExternalDelete(
  table: EngineTable,
  id: string,
): ParameterizedSql {
  const params = new SqlParams();
  const where = keyMatch(table, keyValues(table, id), params);
  return {
    text: `delete from ${tableSql(table)} where ${where}`,
    values: params.values,
  };
}

/**
 * Adds a row. On PostgreSQL and SQL Server the statement returns the new
 * row's id; MySQL and MariaDB have no RETURNING for it, so
 * `buildInsertedId` reads it next, in the same transaction.
 */
export function buildExternalInsert(
  table: EngineTable,
  values: readonly ExternalValue[],
): ParameterizedSql {
  const { dialect, key } = external(table);
  const d = dialectOf(table);
  const params = new SqlParams();
  const set = assignments(dialect, values, params);
  // A row of defaults only: MySQL and MariaDB have no DEFAULT VALUES, and
  // Oracle takes the default of one column by name.
  const [first] = key;
  const named =
    set.length > 0
      ? ` (${set.map((item) => item.name).join(", ")})`
      : dialect === "oracle" && first !== undefined
        ? ` (${quoteExternalIdent(first)})`
        : "";
  const into = `insert into ${tableSql(table)}${named}`;
  const rows =
    set.length > 0
      ? ` values (${set.map((item) => item.sql).join(", ")})`
      : dialect === "mysql" || dialect === "mariadb"
        ? " () values ()"
        : dialect === "oracle"
          ? " values (default)"
          : " default values";
  if (dialect === "postgres") {
    const id = d.keyId(key.map((name) => quoteExternalIdent(name)));
    return {
      text: `${into}${rows} returning ${id} as "id"`,
      values: params.values,
    };
  }
  if (dialect === "sqlserver") {
    // OUTPUT INTO a table variable: a plain OUTPUT fails on a table with
    // triggers, and OUTPUT takes no subquery.
    const columns = key.map((name, index) => {
      const type = declared(keyType(table, name));
      if (!type) throw new AppError("source_row_key_unknown");
      return { name, alias: `k${String(index)}`, type };
    });
    const id = d.keyId(columns.map((column) => `a."${column.alias}"`));
    return {
      text: `declare @ag table (${columns.map((column) => `"${column.alias}" ${column.type}`).join(", ")}); ${into} output ${columns.map((column) => `inserted.${quoteExternalIdent(column.name)}`).join(", ")} into @ag${rows}; select ${id} as "id" from @ag a`,
      values: params.values,
    };
  }
  if (dialect === "oracle" && key.length > 0) {
    // RETURNING takes INTO there: a block keeps the key in variables of
    // the columns' own types, then gives the id back as a result.
    const kept = key.map((_, index) => `"ag_k${String(index)}"`);
    const declared = key
      .map(
        (name, index) =>
          `${kept[index] ?? ""} ${tableSql(table)}.${quoteExternalIdent(name)}%type;`,
      )
      .join(" ");
    return {
      text: `declare ${declared} "ag_id" sys_refcursor; begin ${into}${rows} returning ${key.map((name) => quoteExternalIdent(name)).join(", ")} into ${kept.join(", ")}; open "ag_id" for select ${d.keyId(kept)} as "id" from dual; dbms_sql.return_result("ag_id"); end;`,
      values: params.values,
    };
  }
  return { text: `${into}${rows}`, values: params.values };
}

/**
 * MySQL and MariaDB: the id of the row just added, from the key values it
 * was given, else from its AUTO_INCREMENT key. Null when neither names it.
 */
export function buildInsertedId(
  table: EngineTable,
  values: readonly ExternalValue[],
): ParameterizedSql | null {
  const { key } = external(table);
  const d = dialectOf(table);
  const params = new SqlParams();
  const id = d.keyId(key.map((name) => `t.${quoteExternalIdent(name)}`));
  const given = key.map((name) =>
    values.find((item) => item.column.physical.name === name),
  );
  if (given.every((item) => item && item.value !== null)) {
    const where = key
      .map((name, index) => {
        const item = given[index];
        if (!item) throw new AppError("source_row_key_unknown");
        return `t.${quoteExternalIdent(name)} = ${writeValue(d.name, item.column, item.value, params)}`;
      })
      .join(" and ");
    return {
      text: `select ${id} as "id" from ${tableSql(table)} t where ${where}`,
      values: params.values,
    };
  }
  const [single] = key;
  if (key.length !== 1 || single === undefined) return null;
  return {
    text: `select ${id} as "id" from ${tableSql(table)} t where t.${quoteExternalIdent(single)} = last_insert_id()`,
    values: [],
  };
}

/**
 * Whether two values of a cell are the same, as the read engine returns
 * them: numbers by value (`12.50` is `12.5`), anything else exactly.
 */
export function sameCell(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    left === undefined ||
    right === undefined
  )
    return (left ?? null) === (right ?? null);
  const number = (value: unknown) =>
    typeof value === "number"
      ? numberToDecimal(value)
      : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)
        ? value
        : undefined;
  const a = number(left);
  const b = number(right);
  if (a !== undefined && b !== undefined) return canonical(a) === canonical(b);
  return JSON.stringify(left) === JSON.stringify(right);
}

/** `-012.50` reads `-12.5`; `-0` reads `0`. */
function canonical(text: string): string {
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace(/^-/, "").split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  const decimals = trimEndRun(fraction, "0");
  const body = decimals ? `${integer}.${decimals}` : integer;
  return negative && body !== "0" ? `-${body}` : body;
}

/* ------------------------------------------------------------------ */
/* Side tables (ADR 0032)                                              */
/* ------------------------------------------------------------------ */

/** Field types a side table keeps: values AnyGridDB writes back exactly. */
export const SIDE_FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "boolean",
  "date",
  "datetime",
  "single_select",
  "email",
  "url",
  "phone",
  "rating",
] as const;

type SideFieldType = (typeof SIDE_FIELD_TYPES)[number];

export function isSideFieldType(type: string): type is SideFieldType {
  return (SIDE_FIELD_TYPES as readonly string[]).includes(type);
}

const SIDE_TYPES: Record<DialectName, Record<SideFieldType, string>> = {
  postgres: {
    text: "text",
    long_text: "text",
    number: "numeric",
    boolean: "boolean",
    date: "date",
    datetime: "timestamp with time zone",
    single_select: "text",
    email: "text",
    url: "text",
    phone: "text",
    rating: "integer",
  },
  mysql: {
    text: "varchar(1000)",
    long_text: "mediumtext",
    number: "decimal(38,10)",
    boolean: "tinyint(1)",
    date: "date",
    datetime: "datetime(6)",
    single_select: "varchar(200)",
    email: "varchar(500)",
    url: "varchar(2000)",
    phone: "varchar(100)",
    rating: "int",
  },
  mariadb: {
    text: "varchar(1000)",
    long_text: "mediumtext",
    number: "decimal(38,10)",
    boolean: "tinyint(1)",
    date: "date",
    datetime: "datetime(6)",
    single_select: "varchar(200)",
    email: "varchar(500)",
    url: "varchar(2000)",
    phone: "varchar(100)",
    rating: "int",
  },
  sqlserver: {
    text: "nvarchar(1000)",
    long_text: "nvarchar(max)",
    number: "decimal(38,10)",
    boolean: "bit",
    date: "date",
    datetime: "datetime2(7)",
    single_select: "nvarchar(200)",
    email: "nvarchar(500)",
    url: "nvarchar(2000)",
    phone: "nvarchar(100)",
    rating: "int",
  },
  oracle: {
    text: "varchar2(1000)",
    long_text: "clob",
    number: "number(38,10)",
    boolean: "number(1)",
    date: "date",
    datetime: "timestamp(6) with time zone",
    single_select: "varchar2(200)",
    email: "varchar2(500)",
    url: "varchar2(2000)",
    phone: "varchar2(100)",
    rating: "number(10)",
  },
};

/** The SQL type a side column of `fieldType` has on an engine. */
export function sideColumnType(
  dialect: DialectName,
  fieldType: SideFieldType,
): string {
  return SIDE_TYPES[dialect][fieldType];
}

function sideSql(table: EngineTable): string {
  const side = external(table).side;
  if (!side) throw new AppError("internal_error", "no side table");
  return `${quoteExternalIdent(side.schema)}.${quoteExternalIdent(side.name)}`;
}

/**
 * The side table of an exposed table, keyed like it: the client's key
 * columns, in their declared types, and nothing else until a field is
 * added. No foreign key: the client's table stays as it is.
 */
export function buildSideTable(table: EngineTable): ParameterizedSql {
  const { key } = external(table);
  const columns = key.map((name) => {
    const type = declared(keyType(table, name));
    if (!type) throw new AppError("source_row_key_unknown");
    return `${quoteExternalIdent(name)} ${type} not null`;
  });
  return {
    text: `create table ${sideSql(table)} (${columns.join(", ")}, primary key (${key.map((name) => quoteExternalIdent(name)).join(", ")}))`,
    values: [],
  };
}

/** A field's column in the side table: nullable, of its field's type. */
export function buildSideColumn(
  table: EngineTable,
  name: string,
  fieldType: SideFieldType,
): ParameterizedSql {
  const { dialect } = external(table);
  const add =
    dialect === "sqlserver" || dialect === "oracle" ? "add" : "add column";
  return {
    text: `alter table ${sideSql(table)} ${add} ${quoteExternalIdent(name)} ${sideColumnType(dialect, fieldType)} null`,
    values: [],
  };
}

/**
 * Writes side values of one row, adding its side row if it has none: the
 * row is the client's row the key names. The client's row is locked by
 * then, so two writers never race for the side row.
 */
export function buildSideUpsert(
  table: EngineTable,
  id: string,
  values: readonly ExternalValue[],
): ParameterizedSql {
  const { key, dialect } = external(table);
  const params = new SqlParams();
  const keys = keyValues(table, id).map((value, index) => {
    const name = key[index] ?? "";
    return {
      name: quoteExternalIdent(name),
      sql: keyParam(dialect, keyType(table, name), params.bind(value)),
    };
  });
  const set = assignments(dialect, values, params);
  if (set.length === 0) throw new AppError("no_columns");
  const into = `insert into ${sideSql(table)} (${[...keys, ...set].map((item) => item.name).join(", ")}) values (${[...keys, ...set].map((item) => item.sql).join(", ")})`;
  switch (dialect) {
    case "postgres":
      return {
        text: `${into} on conflict (${keys.map((item) => item.name).join(", ")}) do update set ${set.map((item) => `${item.name} = excluded.${item.name}`).join(", ")}`,
        values: params.values,
      };
    case "sqlserver": {
      const where = keys
        .map((item) => `${item.name} = ${item.sql}`)
        .join(" and ");
      return {
        text: `update ${sideSql(table)} set ${set.map((item) => `${item.name} = ${item.sql}`).join(", ")} where ${where}; if @@rowcount = 0 ${into}`,
        values: params.values,
      };
    }
    case "oracle": {
      const cols = [...keys, ...set];
      const match = keys
        .map((item) => `t.${item.name} = src.${item.name}`)
        .join(" and ");
      return {
        text: `merge into ${sideSql(table)} t using (select ${cols.map((item) => `${item.sql} as ${item.name}`).join(", ")} from dual) src on (${match}) when matched then update set ${set.map((item) => `t.${item.name} = src.${item.name}`).join(", ")} when not matched then insert (${cols.map((item) => item.name).join(", ")}) values (${cols.map((item) => `src.${item.name}`).join(", ")})`,
        values: params.values,
      };
    }
    default:
      return {
        text: `${into} on duplicate key update ${set.map((item) => `${item.name} = values(${item.name})`).join(", ")}`,
        values: params.values,
      };
  }
}

/** A deleted row's side values go with it. */
export function buildSideDelete(
  table: EngineTable,
  id: string,
): ParameterizedSql {
  const params = new SqlParams();
  const where = keyMatch(table, keyValues(table, id), params);
  return {
    text: `delete from ${sideSql(table)} where ${where}`,
    values: params.values,
  };
}

/**
 * Side rows for the rows `ids` name, where they have none: an empty one
 * to lock, so a change of AnyGridDB's own fields on a row of a table the
 * account may not update is compared under a lock too.
 */
export function buildSideEnsure(
  table: EngineTable,
  ids: readonly string[],
): ParameterizedSql | null {
  const { key, dialect } = external(table);
  // SQL Server's HOLDLOCK locks a missing row's key: nothing to add.
  if (dialect === "sqlserver") return null;
  const params = new SqlParams();
  const names = key.map((name) => quoteExternalIdent(name)).join(", ");
  if (dialect === "oracle") {
    const statements = ids.map((id) => {
      const values = keyValues(table, id);
      const where = keyMatch(table, values, params);
      const row = values
        .map((value, index) =>
          keyParam(
            dialect,
            keyType(table, key[index] ?? ""),
            params.bind(value),
          ),
        )
        .join(", ");
      return `insert into ${sideSql(table)} (${names}) select ${row} from dual where not exists (select 1 from ${sideSql(table)} where ${where});`;
    });
    // One call runs one statement: a block holds them all.
    return {
      text: `begin ${statements.join(" ")} end;`,
      values: params.values,
    };
  }
  const rows = ids.map(
    (id) =>
      `(${keyValues(table, id)
        .map((value, index) =>
          keyParam(
            dialect,
            keyType(table, key[index] ?? ""),
            params.bind(value),
          ),
        )
        .join(", ")})`,
  );
  return {
    text:
      dialect === "postgres"
        ? `insert into ${sideSql(table)} (${names}) values ${rows.join(", ")} on conflict do nothing`
        : `insert ignore into ${sideSql(table)} (${names}) values ${rows.join(", ")}`,
    values: params.values,
  };
}

/** Locks side rows until the write's transaction ends. */
export function buildSideLock(
  table: EngineTable,
  ids: readonly string[],
): ParameterizedSql {
  const params = new SqlParams();
  const { dialect } = external(table);
  const where = rowsMatch(table, ids, params);
  return {
    text: lockRows(dialect, sideSql(table), where),
    values: params.values,
  };
}
