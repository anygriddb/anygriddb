/**
 * How a column of a client database shows in AnyGridDB (ADR 0006). A type
 * AnyGridDB reads exactly becomes a field of that type; anything else
 * (geometry, XML, ranges, arrays, binary) shows as read-only text.
 */
import type { FieldType } from "./field-types";
import { cutAt, cutAtSpace, withoutOuterGroup } from "./plain-text";

type SourceColumnType = {
  /** The engine's own name of the type, such as `numeric(12,2)`. */
  type: string;
  /** PostgreSQL's type category, or the engine's family of types. */
  category?: string;
  /** The labels of an enumeration, in order. */
  enumValues?: readonly string[];
};

export type MappedField = {
  fieldType: FieldType;
  /** True when AnyGridDB cannot write the value back as it read it. */
  readOnly: boolean;
  options?: readonly string[];
};

const POSTGRES: Record<string, FieldType> = {
  smallint: "number",
  integer: "number",
  bigint: "number",
  numeric: "number",
  real: "number",
  "double precision": "number",
  text: "long_text",
  "character varying": "text",
  character: "text",
  citext: "text",
  name: "text",
  uuid: "text",
  boolean: "boolean",
  date: "date",
  "timestamp without time zone": "datetime",
  "timestamp with time zone": "datetime",
};

/** The base name of a PostgreSQL type: `numeric(12,2)` reads as `numeric`. */
function baseName(type: string): string {
  return withoutOuterGroup(type).replace(/\[\]$/, "").trim().toLowerCase();
}

export function mapPostgresType(column: SourceColumnType): MappedField {
  if (column.enumValues && column.enumValues.length > 0) {
    return {
      fieldType: "single_select",
      readOnly: false,
      options: column.enumValues,
    };
  }
  // Arrays and composite values have no field that holds them exactly.
  if (column.category === "A" || column.type.endsWith("[]")) {
    return { fieldType: "long_text", readOnly: true };
  }
  const fieldType = POSTGRES[baseName(column.type)];
  if (fieldType) return { fieldType, readOnly: false };
  if (baseName(column.type) === "json" || baseName(column.type) === "jsonb") {
    return { fieldType: "long_text", readOnly: true };
  }
  return { fieldType: "text", readOnly: true };
}

const MYSQL: Record<string, FieldType> = {
  tinyint: "number",
  smallint: "number",
  mediumint: "number",
  int: "number",
  integer: "number",
  bigint: "number",
  decimal: "number",
  numeric: "number",
  float: "number",
  double: "number",
  real: "number",
  year: "number",
  char: "text",
  varchar: "text",
  tinytext: "long_text",
  text: "long_text",
  mediumtext: "long_text",
  longtext: "long_text",
  date: "date",
  datetime: "datetime",
  timestamp: "datetime",
};

/** The labels of `enum('a','b''c')`, as MySQL and MariaDB print them. */
export function mysqlEnumValues(columnType: string): string[] | undefined {
  const body = /^enum\((.*)\)$/is.exec(columnType.trim())?.[1];
  if (body === undefined) return undefined;
  // One pass over the quoted labels, where `''` and a backslash escape the
  // next character: a pattern with those alternatives backtracks on a long
  // run of escapes.
  const values: string[] = [];
  let at = body.indexOf("'");
  while (at >= 0) {
    let value = "";
    let closed = false;
    let i = at + 1;
    while (i < body.length) {
      const char = body.charAt(i);
      if (char === "\\" && i + 1 < body.length) {
        value += body.charAt(i + 1);
        i += 2;
      } else if (char === "'" && body.charAt(i + 1) === "'") {
        value += "'";
        i += 2;
      } else if (char === "'") {
        closed = true;
        i += 1;
        break;
      } else {
        value += char;
        i += 1;
      }
    }
    if (!closed) break;
    values.push(value);
    at = body.indexOf("'", i);
  }
  return values;
}

/**
 * A column of MySQL or MariaDB: `tinyint(1)` is their boolean, an `enum`
 * a single select; JSON, sets, times, bits, binaries, and spatial types
 * show as read-only text.
 */
export function mapMysqlType(column: { type: string }): MappedField {
  const type = column.type.trim().toLowerCase();
  if (/^tinyint\(1\)(\s+unsigned)?$/.test(type)) {
    return { fieldType: "boolean", readOnly: false };
  }
  const options = mysqlEnumValues(column.type);
  if (options && options.length > 0) {
    return { fieldType: "single_select", readOnly: false, options };
  }
  const base = cutAtSpace(cutAt(type, "("));
  const fieldType = MYSQL[base];
  if (fieldType) return { fieldType, readOnly: false };
  if (base === "json") return { fieldType: "long_text", readOnly: true };
  return { fieldType: "text", readOnly: true };
}

const SQL_SERVER: Record<string, FieldType> = {
  tinyint: "number",
  smallint: "number",
  int: "number",
  bigint: "number",
  decimal: "number",
  numeric: "number",
  money: "number",
  smallmoney: "number",
  float: "number",
  real: "number",
  char: "text",
  varchar: "text",
  nchar: "text",
  nvarchar: "text",
  text: "long_text",
  ntext: "long_text",
  bit: "boolean",
  date: "date",
  datetime: "datetime",
  datetime2: "datetime",
  smalldatetime: "datetime",
  datetimeoffset: "datetime",
};

const ORACLE: Record<string, FieldType> = {
  number: "number",
  float: "number",
  binary_float: "number",
  binary_double: "number",
  char: "text",
  nchar: "text",
  varchar2: "text",
  nvarchar2: "text",
  clob: "long_text",
  nclob: "long_text",
  date: "date",
  timestamp: "datetime",
  "timestamp with time zone": "datetime",
  "timestamp with local time zone": "datetime",
  boolean: "boolean",
};

/**
 * A column of Oracle: NUMBER(1) is its usual flag, as BOOLEAN is from 23ai;
 * DATE, which also holds a time of day, reads as a date. JSON shows as
 * read-only long text; RAW, BLOB, intervals, ROWID, XML, and spatial types
 * as read-only text.
 */
export function mapOracleType(column: { type: string }): MappedField {
  const type = column.type.trim().toLowerCase();
  const base = cutAtSpace(cutAt(type, "("));
  if (/^number\(1\)$/.test(type)) {
    return { fieldType: "boolean", readOnly: false };
  }
  const fieldType = ORACLE[base];
  if (fieldType) return { fieldType, readOnly: false };
  if (base === "json") return { fieldType: "long_text", readOnly: true };
  return { fieldType: "text", readOnly: true };
}

/**
 * A column of SQL Server: `bit` is its checkbox, `varchar(max)` long text;
 * uniqueidentifier, time, binaries, XML, spatial types, and rowversion
 * show as read-only text.
 */
export function mapSqlServerType(column: { type: string }): MappedField {
  const type = column.type.trim().toLowerCase();
  const base = cutAt(type, "(");
  if (/^n?varchar\(max\)$/.test(type)) {
    return { fieldType: "long_text", readOnly: false };
  }
  const fieldType = SQL_SERVER[base];
  if (fieldType) return { fieldType, readOnly: false };
  return { fieldType: "text", readOnly: true };
}

/** A string literal as engines print one: `'a'`, `N'a'`, `_utf8mb4'a'`. */
const LITERAL = /(?:\bN|_[a-z0-9]+)?'((?:[^'\\]|''|\\.)*)'/gi;
/** A cast, as PostgreSQL prints it: `::text`, `::character varying[]`. */
const CAST = /::\s*[a-z_][a-z0-9_ ]*(?:\[\])?/gi;
const ALLOWED = new Set(["C", "L", "=", "ANY", "ARRAY", "IN", "OR", "CHECK"]);

function quotedNames(column: string): string[] {
  return [`"${column}"`, `[${column}]`, `\`${column}\``];
}

/**
 * The values a check constraint lists for one text column, in its order:
 * `status IN ('draft', 'sent')` as each engine prints it, or `=` joined by
 * OR. Null when the check says anything else: another column, a range, a
 * pattern, AND, NOT. Such a column reads as a single select, with the
 * constraint's values as options (ADR 0006).
 */
export function checkChoices(
  definition: string | null | undefined,
  column: string,
): string[] | null {
  if (!definition || definition.length > 4_000) return null;
  // MySQL prints CHECK_CLAUSE's quotes escaped: `_latin1\'low\'`.
  const text = /(^|[^\\])'/.test(definition)
    ? definition
    : definition.replace(/\\'/g, "'");
  const values: string[] = [];
  let skeleton = text.replace(LITERAL, (_match, body: string) => {
    values.push(body.replace(/''/g, "'").replace(/\\(.)/g, "$1"));
    return " L ";
  });
  skeleton = skeleton.replace(CAST, " ");
  for (const name of quotedNames(column)) {
    skeleton = skeleton.split(name).join(" C ");
  }
  if (/^\w+$/.test(column)) {
    skeleton = skeleton.replace(new RegExp(`\\b${column}\\b`, "g"), " C ");
  }
  skeleton = skeleton.replace(/=/g, " = ");
  const tokens = skeleton
    .split(/[\s(),[\]]+/)
    .filter((token) => token.length > 0)
    .map((token) =>
      token === "C" || token === "L" ? token : token.toUpperCase(),
    );
  if (
    values.length === 0 ||
    !tokens.includes("C") ||
    tokens.some((token) => !ALLOWED.has(token))
  ) {
    return null;
  }
  return [...new Set(values)];
}

/** A text column a check limits to a list reads as a single select of it. */
export function withChoices(
  field: MappedField,
  choices: readonly string[] | null,
): MappedField {
  if (!choices || choices.length === 0 || choices.length > 200) return field;
  if (field.fieldType !== "text" && field.fieldType !== "long_text") {
    return field;
  }
  return {
    fieldType: "single_select",
    readOnly: field.readOnly,
    options: choices,
  };
}
