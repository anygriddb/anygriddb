/**
 * What differs between the SQL engines a read compiles for (ADR 0005).
 * The compiler emits one query shape; a dialect renders the constructs
 * engines spell differently. Where an engine computes a function its own
 * way, the compiler records a limit the field shows (ADR 0027); what a
 * dialect cannot produce at all it refuses (`function_unavailable`). A
 * result is never silently different.
 *
 * Every dialect writes identifiers in double quotes and joins text with
 * `||`: MySQL and MariaDB sessions run with ANSI_QUOTES, PIPES_AS_CONCAT,
 * and NO_BACKSLASH_ESCAPES, so literals read as they do in PostgreSQL.
 * Placeholders are always `$n`; the driver of each engine rewrites them.
 */
import { AppError } from "../errors";
import { jsonPathText, jsonSteps, type JsonStep } from "./json-path";
import type { PortableRegex, ReplacementPart } from "./regex";
import { isTimeZone } from "../field-config";
import {
  isWritableType,
  physicalSqlType,
  type FieldType,
} from "../field-types";
import type { EngineTable, PhysicalColumn } from "./engine";
import type { ScalarKind } from "./expressions";
import { SQLSERVER } from "./dialect-sqlserver";
import { exactMedian } from "./median";

export type DialectName = "postgres" | "mysql" | "mariadb" | "sqlserver";

export type SortDirection = "asc" | "desc";

export interface SqlDialect {
  /** The server's version, when the catalog knows it (`[16, 4]`). */
  version?: readonly number[];
  readonly name: DialectName;
  /** A boolean literal as a value. */
  boolLiteral(value: boolean): string;
  /**
   * A boolean value as a condition. Most engines read one as the other;
   * T-SQL keeps conditions (WHERE, WHEN) apart from values (BIT).
   */
  cond(sql: string): string;
  /**
   * A condition as a boolean value. Most engines read one as the other;
   * T-SQL makes it a BIT, null when the condition is unknown.
   */
  boolValue(condition: string): string;
  /** A condition that is false where `condition` is unknown. */
  truth(condition: string): string;
  /** 1 or 0 as a boolean value. */
  bitOf(sql: string): string;
  /** The time zone a read binds, as the engine names it. */
  zone(iana: string): string;
  /** A typed null. */
  nullOf(kind: ScalarKind): string;
  /** A bound number (a decimal string), exact. */
  numberParam(placeholder: string): string;
  /** A bound text. */
  textParam(placeholder: string): string;
  /** A bound whole number. */
  intParam(placeholder: string): string;
  /** A count as a number the driver returns. */
  count(sql: string): string;
  /** A number as its shortest exact text: `12.50` reads `12.5`. */
  numberText(sql: string): string;
  /** A date as `YYYY-MM-DD`. */
  dateText(sql: string): string;
  /** An instant as `YYYY-MM-DD HH:MM` in the zone `tz`. */
  localDatetimeText(sql: string, tz: string): string;
  /** The day of an instant in the zone `tz`. */
  localDate(sql: string, tz: string): string;
  /** Today in the zone `tz`. */
  today(tz: string): string;
  /** A date `days` later (or earlier, when negative). */
  addDays(date: string, days: string): string;
  /** A date moved by whole months or years. */
  addPeriod(date: string, amount: number, unit: "month" | "year"): string;
  /** The first day of the week (Monday), month, or year of a date. */
  startOf(date: string, unit: "week" | "month" | "year"): string;
  /** Days from `start` to `end`, two dates. */
  daysBetween(end: string, start: string): string;
  /** Seconds from `start` to `end`, two instants. */
  secondsBetween(end: string, start: string): string;
  /** Text matched against a pattern, as `LIKE` with `\` escaping. */
  like(sql: string, pattern: string): string;
  /** A bound list of texts, for `inTexts` and `optionPosition`. */
  textList(items: readonly string[], bind: Bind): string;
  /** True when `sql` equals one of a list's texts. */
  inTexts(sql: string, list: string): string;
  /** `ORDER BY` term with nulls last. */
  orderTerm(sql: string, direction: SortDirection): string;
  /** Position of `sql` in a list of option names, else null. */
  optionPosition(sql: string, list: string): string;
  /** A sortable text: AnyGridDB folds case; MySQL follows the column's collation. */
  sortText(sql: string): string;
  /** A row count that matches a condition, as an aggregate. */
  countWhere(condition: string): string;
  /** A value as JSON, the way the driver returns it. */
  json(sql: string, kind: JsonKind): string;
  /**
   * The select list of a result, from aliases and JSON values: a column
   * each in PostgreSQL; one `ag_row` object in MySQL and MariaDB, which
   * keeps JSON through derived tables and is read back by the driver.
   */
  row(entries: ReadonlyArray<readonly [string, string]>): string;
  /** A group key: JSON that is never SQL null, so ROLLUP's nulls stand out. */
  groupKey(sql: string, kind: JsonKind): string;
  /** An empty link list. */
  emptyLinks(): string;
  /** Links `[{id, label}]` of the rows `from … where …`, in order. */
  linksAgg(input: {
    id: string;
    label: string;
    from: string;
    where: string;
    order: readonly string[];
  }): string;
  /** The number of links in a link cell. */
  linksLength(sql: string): string;
  /** The first link's label, to sort by. */
  firstLinkLabel(sql: string): string;
  /** True when a link cell has a link whose label matches a pattern. */
  linksLabelLike(sql: string, pattern: string): string;
  /** True when a link cell links one of a list's ids. */
  linksIdIn(sql: string, list: string): string;
  /** A client column read in its field's SQL type. */
  readColumn(
    ref: string,
    fieldType: FieldType,
    physical: PhysicalColumn,
  ): string;
  /** A client table's id from its key columns. */
  keyId(columns: readonly string[]): string;
  /** A row's id for a table or view without a key: its content. */
  contentId(alias: string, columns: readonly string[]): string;
  /** A key as text. */
  keyText(sql: string): string;
  /** ` LIMIT … OFFSET …`, two whole numbers the engine checked. */
  limitOffset(limit: number, offset: number, bind: Bind): string;
  /**
   * Counts per group prefix over `source`, a select of keys `k0…`: one
   * query, with `depth` (how many keys) and `count`.
   */
  groupCounts(input: {
    keys: number;
    source: string;
    limit: number;
    bind: Bind;
  }): string;
  /**
   * One aggregate per group over `source`, a select of keys `k0…` and the
   * columns `value` reads (as `q`): `k0…` and `a0`, ordered by the keys.
   */
  groupAggregates(input: {
    keys: number;
    source: string;
    value: string;
    kind: JsonKind;
    limit: number;
    bind: Bind;
  }): string;
  /** An exact number as its text, scale and all: `14.50`. */
  exactText(sql: string): string;
  /**
   * The median of a column of `source` (a FROM item and its WHERE): the
   * middle value, or the mean of the two middle ones, exact.
   */
  median(sql: string, source: string): string;
  /** The sample standard deviation. */
  stddev(sql: string): string;
  /** The sample variance. */
  variance(sql: string): string;
  /** The population standard deviation. */
  stddevPop(sql: string): string;
  /** The population variance. */
  variancePop(sql: string): string;
  /* Formulas (ADR 0005): AnyGridDB's semantics, reproduced exactly. */
  /** A bound decimal literal: exact, at its own scale where it matters. */
  numberLiteral(placeholder: string, value: string): string;
  /** A computed number as canonical text: `14.50` reads `14.5`. */
  computedText(sql: string): string;
  /** `a / b`, rounded to 20 decimal places; null when `b` is zero. */
  divide(a: string, b: string): string;
  /** Text read as a number, when it is one. */
  textToNumber(sql: string): string;
  /** Text read as an instant (ISO 8601), in the zone `tz` when it has none. */
  textToInstant(sql: string, tz: string): string;
  /**
   * Text shaped `YYYY-MM-DD`, `YYYY-MM-DD HH:MM`, or `YYYY-MM-DD HH:MM:SS`
   * as the instant it is in the zone `tz`; blank when it is not a real
   * date and time.
   */
  wallClockInstant(sql: string, tz: string, shape: WallClockShape): string;
  /** Midnight of a date in the zone `tz`, as an instant. */
  dateToInstant(sql: string, tz: string): string;
  /** An instant as the wall clock of the zone `tz`. */
  localTimestamp(sql: string, tz: string): string;
  /** A date as a timestamp at midnight. */
  dateTimestamp(sql: string): string;
  /** Now, as an instant. */
  now(): string;
  /** A part of a wall-clock timestamp, as a number. */
  datePart(part: DatePart, sql: string): string;
  /** Whole months from `start` to `end`, two instants. */
  monthsBetween(end: string, start: string): string;
  /** An instant or a date moved by a whole amount of a unit. */
  addUnit(sql: string, amount: string, unit: TimeUnit, date: boolean): string;
  /** True when two wall-clock timestamps fall in the same unit. */
  sameUnit(a: string, b: string, unit: TimeUnit): string;
  /** A wall-clock timestamp formatted by a `YYYY-MM-DD`-style pattern. */
  formatTimestamp(sql: string, pattern: string, bind: Bind): string;
  /** Texts joined, nulls skipped. */
  concatAll(parts: readonly string[]): string;
  /** Text without spaces at either end. */
  trim(sql: string): string;
  /** The position of `needle` in `haystack` from `start` (0 when absent). */
  locate(
    needle: string,
    haystack: string,
    start: string,
    foldCase: boolean,
  ): string;
  /** `text` with `length` characters from `start` replaced by `insert`. */
  overlay(text: string, insert: string, start: string, length: string): string;
  /** Two texts compared by code point, so the result is the same everywhere. */
  compareText(a: string, symbol: string, b: string): string;
  /** A number rounded to a whole number, as an integer. */
  toInt(sql: string): string;
  /** A number bounded to `[low, high]`, a blank read as 0. */
  clamp(sql: string, low: number, high: number): string;
  /** `a` modulo `b`, with the sign of `a`; blank when `b` is zero. */
  mod(a: string, b: string): string;
  /** The smallest whole number at or above a number. */
  ceil(sql: string): string;
  /** The natural logarithm. */
  ln(sql: string): string;
  /** EXP and POWER stop past e to this power: their result is blank. */
  readonly expCeiling: number;
  /** A text's length in characters, spaces at its end included. */
  textLength(sql: string): string;
  /** True when a text has a character; unknown when it is blank. */
  textFilled(sql: string): string;
  /** A text repeated `count` times. */
  repeat(sql: string, count: string): string;
  /** Every `search` in `text` replaced, matching case and accents exactly. */
  replaceText(text: string, search: string, replacement: string): string;
  /** A number cut to `digits` decimal places (negative cuts left of the point). */
  truncate(sql: string, digits: string): string;
  /** The logarithm of `sql` in `base`. */
  log(base: string, sql: string): string;
  /** `base` to the power `exponent`, in floating point but on PostgreSQL. */
  power(base: string, exponent: string): string;
  /**
   * A floating-point result (SQRT, EXP, LN, LOG, POWER) as the engine's
   * exact number, so what follows it computes exactly again.
   */
  fromFloat(sql: string): string;
  /** A number rounded away from zero to `digits` decimal places. */
  roundUp(sql: string, digits: string): string;
  /* Lists: lookups, and link labels a formula reads. */
  /** The values of `element` over `from … where …`, in order, as a list. */
  listAgg(input: ListInput & { kind: ScalarKind }): string;
  /** The same values as text joined by `separator`, blanks left out. */
  joinAgg(input: ListInput & { separator: string }): string;
  /** An empty list of a kind. */
  emptyList(kind: ScalarKind): string;
  /** The number of values in a list. */
  listLength(sql: string): string;
  /** True when a list holds a text that matches a pattern. */
  listTextLike(sql: string, pattern: string): string;
  /** True when a list holds any, all, none, or exactly the listed texts. */
  listHas(
    sql: string,
    test: "any" | "all" | "none" | "exactly",
    items: readonly string[],
    bind: Bind,
  ): string;
  /** A list as text to sort by. */
  listSortText(sql: string): string;
  /**
   * A list's values joined by `separator` in order, blanks left out:
   * `text` reads each value as `alias.v`.
   */
  listJoin(
    list: string,
    alias: string,
    text: string,
    separator: string,
  ): string;
  /** An instant as a list holds it (JSON text elsewhere than PostgreSQL). */
  listInstant(sql: string): string;
  /** A list without repeated values, each where it first appears. */
  listUnique(list: string, kind: ScalarKind): string;
  /** A list without its blank values. */
  listCompact(list: string, kind: ScalarKind): string;
  /** The sum of a list of numbers. */
  listSum(list: string): string;
  /** ENCODE_URL_COMPONENT: `A-Za-z0-9_.~-` kept, the rest as %-encoded UTF-8. */
  encodeUrl(sql: string): string;
  /** A text's UTF-8 bytes hashed, as lower-case hex. */
  hashHex(sql: string, algorithm: HashAlgorithm): string;
  /** A text from character `start` (1-based) to its end. */
  textFrom(sql: string, start: string): string;
  /**
   * The value at `path` in a JSON text: a scalar as text (a string
   * unquoted), an object or a list as its JSON, blank for JSON null, a
   * missing path, or text that is not JSON.
   */
  jsonExtract(sql: string, path: readonly JsonStep[], bind: Bind): string;
  /** Whether a text matches a portable pattern (`regex.ts`): a condition. */
  regexMatch(sql: string, regex: PortableRegex, bind: Bind): string;
  /** The first match of a pattern in a text; blank without one. */
  regexExtract(sql: string, regex: PortableRegex, bind: Bind): string;
  /**
   * Every match replaced: by parts written in the formula, or by a text
   * read as it is.
   */
  regexReplace(
    sql: string,
    regex: PortableRegex,
    replacement: readonly ReplacementPart[] | { sql: string },
    bind: Bind,
  ): string;
  /**
   * A join that repeats each row of a FROM once per value of `list`, a
   * list that row computes: `alias.i` its place, `alias.v` its value.
   */
  listItemsJoin(list: string, alias: string): string;
  /** A list's value, as `alias.v` reads it, back as the kind it was. */
  listValue(sql: string, kind: ScalarKind): string;
  /**
   * A list as a FROM item of a subquery, `alias.v` its values and `alias.i`
   * their places: it may read the outer row.
   */
  listFrom(list: string, alias: string): string;
  /** A list of one value. */
  listOne(sql: string, kind: ScalarKind): string;
  /**
   * A JSON object of texts, keys written out (column names); a null value
   * is left out or kept as null.
   */
  jsonObject(entries: ReadonlyArray<readonly [string, string]>): string;
  /**
   * A text cut at each delimiter, matched exactly: a list of texts. An
   * empty text has no parts; an empty delimiter leaves the text whole.
   */
  textSplit(text: string, delimiter: string): string;
  /** A list in order, blanks last, texts by code point; ties keep their places. */
  listSort(list: string, kind: ScalarKind, descending: boolean): string;
  /** A list's values from place `from` to place `to` (1-based, both kept). */
  listSlice(list: string, kind: ScalarKind, from: string, to: string): string;
  /** Lists of one kind, one after the other. */
  listConcat(lists: readonly string[], kind: ScalarKind): string;
  /**
   * Values named once, as a FROM item of one row that may read the outer
   * row: `alias.name` reads each, however often.
   */
  boundRow(values: readonly BoundValue[], alias: string): string;
  /** An aggregate over a list's values; `counta` counts the filled ones. */
  listAggregate(
    list: string,
    fn: "sum" | "count" | "counta" | "min" | "max",
    kind: ScalarKind,
  ): string;
  /** A text value distinct by code point, for DISTINCT and its order. */
  exactTextKey(sql: string): string;
  /** Throws when the engine cannot reproduce `what` exactly. */
  unavailable(what: string): never;
}

/** The rows a list aggregates, and their order. */
export type ListInput = {
  element: string;
  from: string;
  where: string;
  order: readonly string[];
};

export type DatePart =
  "year" | "month" | "day" | "hour" | "minute" | "second" | "dow" | "week";

export type TimeUnit =
  "year" | "month" | "week" | "day" | "hour" | "minute" | "second";

/** Binds a value and returns its placeholder. */
export type Bind = (value: unknown) => string;

export type HashAlgorithm = "md5" | "sha256" | "sha512";

/** Whether the server is at least `wanted`; true when its version is unknown. */
export function serverAtLeast(
  d: SqlDialect,
  wanted: readonly number[],
): boolean {
  const version = d.version;
  if (!version) return true;
  for (const [index, part] of wanted.entries()) {
    const have = version[index] ?? 0;
    if (have !== part) return have > part;
  }
  return true;
}

/** `16.4 (Debian 16.4-1)`, `8.4.3`, `11.4.4-MariaDB`, `16.0.4135.4` as numbers. */
export function parseServerVersion(
  text: string | null | undefined,
): number[] | undefined {
  const digits = /^\s*(\d+(?:\.\d+){0,2})/.exec(text ?? "")?.[1];
  return digits?.split(".").map(Number);
}

export type WallClockShape = "date" | "minute" | "second";

/** A value `boundRow` names: its SQL and its type. */
export type BoundValue = { name: string; sql: string; type: "date" | "int" };

/** The values of `boundRow` as the columns of a one-row derived table. */
function boundSelect(values: readonly BoundValue[], alias: string): string {
  return `(select ${values.map((value) => `${value.sql} as ${value.name}`).join(", ")}) ${alias}`;
}

export type JsonKind =
  "text" | "number" | "boolean" | "date" | "datetime" | "json";

const unavailable = (what: string): never => {
  throw new AppError("function_unavailable", what);
};

/** PostgreSQL's names of the types a field holds natively. */
const SAME_TYPE: Record<string, string> = {
  text: "text",
  numeric: "numeric",
  boolean: "boolean",
  date: "date",
  timestamptz: "timestamp with time zone",
};

/** `numeric(12,2)` reads as `numeric`, `timestamp(3) with time zone` as `timestamp with time zone`. */
function typeName(type: string): string {
  return type
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function zoneLiteral(zone: string): string {
  if (!isTimeZone(zone)) throw new AppError("invalid_input");
  return `'${zone}'`;
}

/** What ENCODE_URL_COMPONENT leaves as it is; the rest is %-encoded UTF-8. */
const UNRESERVED =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.~-";

/**
 * MySQL and MariaDB: every UTF-8 byte as `%XX`, then the unreserved ones
 * back. A `%` only ever starts an encoded byte, so no replacement can
 * match across two of them.
 */
function mysqlEncodeUrl(name: "mysql" | "mariadb", sql: string): string {
  const reference = name === "mysql" ? "$1" : "\\1";
  let encoded = `regexp_replace(hex(convert(${sql} using utf8mb4)), '(..)', '%${reference}')`;
  for (const char of UNRESERVED) {
    const hex = char.charCodeAt(0).toString(16).toUpperCase();
    encoded = `replace(${encoded}, '%${hex}', '${char}')`;
  }
  return encoded;
}

const PG_SCALAR: Record<ScalarKind, string> = {
  number: "numeric",
  text: "text",
  boolean: "boolean",
  date: "date",
  datetime: "timestamptz",
};

export const POSTGRES: SqlDialect = {
  name: "postgres",
  boolLiteral: (value) => (value ? "true" : "false"),
  cond: (sql) => sql,
  boolValue: (condition) => condition,
  truth: (condition) => `coalesce(${condition}, false)`,
  bitOf: (sql) => `(${sql} = 1)`,
  zone: (iana) => iana,
  nullOf: (kind) => `null::${PG_SCALAR[kind]}`,
  numberParam: (placeholder) => `${placeholder}::numeric`,
  textParam: (placeholder) => `${placeholder}::text`,
  intParam: (placeholder) => `${placeholder}::int`,
  count: (sql) => `${sql}::int`,
  numberText: (sql) => `trim_scale(${sql})::text`,
  dateText: (sql) => `to_char(${sql}, 'YYYY-MM-DD')`,
  localDatetimeText: (sql, tz) =>
    `to_char(${sql} at time zone ${tz}, 'YYYY-MM-DD HH24:MI')`,
  localDate: (sql, tz) => `(${sql} at time zone ${tz})::date`,
  today: (tz) => `(now() at time zone ${tz})::date`,
  addDays: (date, days) => `(${date} + ${days})`,
  addPeriod: (date, amount, unit) =>
    `(${date} ${amount < 0 ? "-" : "+"} interval '${String(Math.abs(amount))} ${unit}')::date`,
  startOf: (date, unit) => `date_trunc('${unit}', ${date})::date`,
  daysBetween: (end, start) => `(${end} - ${start})`,
  secondsBetween: (end, start) => `extract(epoch from (${end} - ${start}))`,
  like: (sql, pattern) => `${sql} ilike ${pattern} escape '\\'`,
  textList: (items, bind) =>
    `array(select jsonb_array_elements_text(${bind(JSON.stringify(items))}::text::jsonb))`,
  inTexts: (sql, list) => `${sql} = any(${list})`,
  orderTerm: (sql, direction) => `${sql} ${direction} nulls last`,
  optionPosition: (sql, list) => `array_position(${list}, ${sql})`,
  sortText: (sql) => `lower(${sql})`,
  countWhere: (condition) => `count(*) filter (where ${condition})`,
  json: (sql) => `to_jsonb(${sql})`,
  row: (entries) =>
    entries
      .map(([name, sql]) =>
        sql === `q."${name}"` ? sql : `${sql} as "${name}"`,
      )
      .join(", "),
  groupKey: (sql) => `to_jsonb(${sql})`,
  emptyLinks: () => "'[]'::jsonb",
  linksAgg: ({ id, label, from, where, order }) =>
    `coalesce((select jsonb_agg(jsonb_build_object('id', ${id}, 'label', ${label}) order by ${order.join(", ")}) from ${from} where ${where}), '[]'::jsonb)`,
  linksLength: (sql) => `jsonb_array_length(${sql})`,
  firstLinkLabel: (sql) => `${sql}->0->>'label'`,
  linksLabelLike: (sql, pattern) =>
    `exists (select 1 from jsonb_array_elements(${sql}) e where e->>'label' ilike ${pattern} escape '\\')`,
  linksIdIn: (sql, list) =>
    `exists (select 1 from jsonb_array_elements(${sql}) e where e->>'id' = any(${list}))`,
  readColumn: (ref, fieldType, physical) => {
    if (!isWritableType(fieldType)) return ref;
    const wanted = physicalSqlType(fieldType);
    const stored = typeName(physical.type);
    if (stored === wanted || stored === SAME_TYPE[wanted]) return ref;
    if (wanted === "timestamptz" && stored === "timestamp without time zone") {
      return `(${ref} at time zone ${zoneLiteral(physical.zone)})`;
    }
    return `(${ref})::${wanted}`;
  },
  keyId: (columns) =>
    columns.length === 1
      ? `(${columns[0] ?? ""})::text`
      : `jsonb_build_array(${columns.join(", ")})::text`,
  contentId: (alias) => `md5(row_to_json(${alias})::text)`,
  keyText: (sql) => `${sql}::text`,
  limitOffset: (limit, offset, bind) =>
    ` limit ${bind(limit)} offset ${bind(offset)}`,
  groupCounts: ({ keys, source, limit, bind }) => {
    const names = Array.from(
      { length: keys },
      (_, index) => `"k${String(index)}"`,
    );
    const sets = names.map(
      (_, index) => `(${names.slice(0, index + 1).join(", ")})`,
    );
    const depth = names
      .map((name) => `(case when grouping(${name}) = 0 then 1 else 0 end)`)
      .join(" + ");
    return `select ${names.join(", ")}, (${depth})::int as "depth", count(*)::int as "count" from (${source}) g group by grouping sets (${sets.join(", ")}) limit ${bind(limit)}`;
  },
  groupAggregates: ({ keys, source, value, limit, bind }) => {
    const names = Array.from(
      { length: keys },
      (_, index) => `"k${String(index)}"`,
    );
    return `select ${names.join(", ")}, to_jsonb(${value}) as "a0" from (${source}) q group by ${names.join(", ")} order by ${names.join(", ")} limit ${bind(limit)}`;
  },
  exactText: (sql) => `(${sql})::text`,
  median: exactMedian,
  stddev: (sql) => `stddev_samp(${sql})`,
  variance: (sql) => `var_samp(${sql})`,
  stddevPop: (sql) => `stddev_pop(${sql})`,
  variancePop: (sql) => `var_pop(${sql})`,
  numberLiteral: (placeholder) => `${placeholder}::numeric`,
  computedText: (sql) => `trim_scale(${sql})::text`,
  // A dividend of scale 20 makes PostgreSQL compute 20 decimals at least.
  divide: (a, b) =>
    `round((${a} + 0.00000000000000000000) / nullif(${b}, 0), 20)`,
  textToNumber: (sql) =>
    `(case when ${sql} ~ ${NUMERIC_TEXT} then trim(${sql})::numeric end)`,
  textToInstant: postgresIsoInstant,
  wallClockInstant: (sql, tz) => postgresIsoInstant(sql, tz),
  dateToInstant: (sql, tz) => `(${sql}::timestamp at time zone ${tz})`,
  localTimestamp: (sql, tz) => `(${sql} at time zone ${tz})`,
  dateTimestamp: (sql) => `${sql}::timestamp`,
  now: () => "now()",
  datePart: (part, sql) => `extract(${part} from ${sql})::numeric`,
  monthsBetween: (end, start) => {
    const age = `age(${end}, ${start})`;
    return `(extract(year from ${age}) * 12 + extract(month from ${age}))`;
  },
  addUnit: (sql, amount, unit, date) => {
    const interval = `make_interval(${unit === "minute" ? "mins" : unit === "second" ? "secs" : `${unit}s`} => ${amount})`;
    return date ? `(${sql} + ${interval})::date` : `(${sql} + ${interval})`;
  },
  sameUnit: (a, b, unit) =>
    `(date_trunc('${unit}', ${a}) = date_trunc('${unit}', ${b}))`,
  formatTimestamp: (sql, pattern, bind) =>
    `to_char(${sql}, ${bind(toCharPattern(pattern))}::text)`,
  concatAll: (parts) => `concat(${parts.join(", ")})`,
  trim: (sql) => `btrim(${sql})`,
  locate: (needle, haystack, start) =>
    `coalesce(nullif(strpos(substr(${haystack}, ${start}), ${needle}), 0) + ${start} - 1, 0)`,
  overlay: (text, insert, start, length) =>
    `overlay(${text} placing ${insert} from ${start} for ${length})`,
  compareText: (a, symbol, b) =>
    `(${a} collate "C" ${symbol} ${b} collate "C")`,
  toInt: (sql) => `${sql}::int`,
  clamp: (sql, low, high) =>
    `least(greatest(coalesce(${sql}, 0), ${String(low)}), ${String(high)})`,
  mod: (a, b) => `mod(${a}, nullif(${b}, 0))`,
  ceil: (sql) => `ceil(${sql})`,
  ln: (sql) => `ln(${sql})`,
  expCeiling: 700,
  textLength: (sql) => `char_length(${sql})`,
  textFilled: (sql) => `(${sql} <> '')`,
  repeat: (sql, count) => `repeat(${sql}, ${count})`,
  replaceText: (text, search, replacement) =>
    `replace(${text}, ${search}, ${replacement})`,
  truncate: (sql, digits) => `trunc(${sql}, ${digits})`,
  log: (base, sql) => `log(${base}, ${sql})`,
  power: (base, exponent) => `power(${base}, ${exponent})`,
  fromFloat: (sql) => sql,
  roundUp: (sql, digits) =>
    `(sign(${sql}) * ceil(abs(${sql}) * power(10::numeric, ${digits})) / power(10::numeric, ${digits}))`,
  listAgg: ({ element, from, where, order }) =>
    `array(select ${element} from ${from} where ${where} order by ${order.join(", ")})`,
  joinAgg: ({ element, separator, from, where, order }) =>
    `(select string_agg(${element}, ${separator} order by ${order.join(", ")}) from ${from} where ${where})`,
  emptyList: (kind) => `array[]::${PG_SCALAR[kind]}[]`,
  listLength: (sql) => `cardinality(${sql})`,
  listTextLike: (sql, pattern) =>
    `exists (select 1 from unnest(${sql}) v where v ilike ${pattern} escape '\\')`,
  listHas: (sql, test, items, bind) => {
    const list = `array(select jsonb_array_elements_text(${bind(JSON.stringify(items))}::text::jsonb))`;
    switch (test) {
      case "any":
        return `coalesce(${sql} && ${list}, false)`;
      case "all":
        return `coalesce(${sql} @> ${list}, false)`;
      case "none":
        return `(not coalesce(${sql} && ${list}, false))`;
      case "exactly":
        return `coalesce(${sql} @> ${list} and ${sql} <@ ${list}, false)`;
    }
  },
  listSortText: (sql) => `lower(array_to_string(${sql}::text[], ','))`,
  listJoin: (list, alias, text, separator) =>
    `(select string_agg(${text}, ${separator} order by ${alias}.i) from unnest(${list}) with ordinality ${alias}(v, i))`,
  listInstant: (sql) => sql,
  listUnique: (list) =>
    `array(select u.v from unnest(${list}) with ordinality u(v, i) group by u.v order by min(u.i))`,
  listCompact: (list) =>
    `array(select u.v from unnest(${list}) with ordinality u(v, i) where u.v is not null and u.v::text <> '' order by u.i)`,
  listSum: (list) => `(select sum(v) from unnest(${list}) v)`,
  listItemsJoin: (list, alias) =>
    `cross join lateral unnest(${list}) with ordinality ${alias}(v, i)`,
  listValue: (sql) => sql,
  listFrom: (list, alias) => `unnest(${list}) with ordinality ${alias}(v, i)`,
  listOne: (sql, kind) => `array[${sql}]::${PG_SCALAR[kind]}[]`,
  boundRow: boundSelect,
  jsonObject: (entries) =>
    `jsonb_strip_nulls(jsonb_build_object(${entries.map(([key, sql]) => `'${key}', ${sql}`).join(", ")}))`,
  textSplit: (text, delimiter) =>
    `string_to_array(${text}, coalesce(${delimiter}, ''))`,
  listSort: (list, kind, descending) =>
    `array(select u.v from unnest(${list}) with ordinality u(v, i) order by ${kind === "text" ? `u.v collate "C"` : "u.v"} ${descending ? "desc" : "asc"} nulls last, u.i)`,
  listSlice: (list, _kind, from, to) =>
    `array(select u.v from unnest(${list}) with ordinality u(v, i) where u.i >= ${from} and u.i <= ${to} order by u.i)`,
  listConcat: (lists) => `(${lists.join(" || ")})`,
  listAggregate: (list, fn) =>
    fn === "counta"
      ? `(select count(*) from unnest(${list}) v where v is not null and v::text <> '')`
      : `(select ${fn}(v) from unnest(${list}) v)`,
  encodeUrl: (sql) =>
    `(select string_agg(case when c ~ '^[A-Za-z0-9_.~-]$' then c else upper(regexp_replace(encode(convert_to(c, 'UTF8'), 'hex'), '(..)', '%\\1', 'g')) end, '' order by i) from regexp_split_to_table(${sql}, '') with ordinality as x(c, i))`,
  hashHex: (sql, algorithm) =>
    algorithm === "md5"
      ? `md5(convert_to(${sql}, 'UTF8'))`
      : `encode(${algorithm}(convert_to(${sql}, 'UTF8')), 'hex')`,
  textFrom: (sql, start) => `substr(${sql}, ${start})`,
  // An ARE takes its case option first. The whole match is the first
  // group of the pattern wrapped in one more.
  regexMatch: (sql, regex, bind) =>
    `(${sql} ~ ${bind(`${regex.caseless ? "(?i)" : ""}${regex.pattern}`)}::text)`,
  regexExtract: (sql, regex, bind) =>
    `(regexp_match(${sql}, ${bind(`${regex.caseless ? "(?i)" : ""}(${regex.pattern})`)}::text))[1]`,
  regexReplace: (sql, regex, replacement, bind) => {
    const pattern = `${regex.caseless ? "(?i)" : ""}${regex.pattern}`;
    const written =
      "sql" in replacement
        ? `replace(${replacement.sql}, '\\', '\\\\')`
        : `${bind(
            replacement
              .map((part) =>
                "text" in part
                  ? part.text.replace(/\\/g, "\\\\")
                  : part.group === 0
                    ? "\\&"
                    : `\\${String(part.group)}`,
              )
              .join(""),
          )}::text`;
    return `regexp_replace(${sql}, ${bind(pattern)}::text, ${written}, 'g')`;
  },
  // Text that is not JSON becomes null before the cast, which a planner
  // folding a constant then never sees. Strict mode reads only the path
  // written; a mismatch is blank (silent).
  jsonExtract: (sql, path, bind) =>
    `(jsonb_path_query_first((case when pg_input_is_valid(${sql}, 'jsonb') then ${sql} end)::jsonb, ${bind(`strict $${jsonSteps(path)}`)}::jsonpath, '{}', true) #>> '{}')`,
  exactTextKey: (sql) => `(${sql}) collate "C"`,
  unavailable,
};

/** MySQL's and MariaDB's text of a number: `12.50` reads `12.5`, `3.0` reads `3`. */
function mysqlNumberText(sql: string): string {
  const text = `cast(${sql} as char)`;
  return `(case when locate('.', ${text}) > 0 and locate('e', lower(${text})) = 0 then trim(trailing '.' from trim(trailing '0' from ${text})) else ${text} end)`;
}

const FORMAT_TOKENS: Array<[string, string]> = [
  ["YYYY", "YYYY"],
  ["YY", "YY"],
  ["MMMM", "FMMonth"],
  ["MMM", "Mon"],
  ["MM", "MM"],
  ["M", "FMMM"],
  ["DD", "DD"],
  ["D", "FMDD"],
  ["dddd", "FMDay"],
  ["ddd", "Dy"],
  ["HH", "HH24"],
  ["H", "FMHH24"],
  ["hh", "HH12"],
  ["h", "FMHH12"],
  ["mm", "MI"],
  ["ss", "SS"],
  ["A", "AM"],
  ["a", "am"],
];

/** Maps a `YYYY-MM-DD HH:mm` style pattern to a `to_char` pattern. */
export function toCharPattern(pattern: string): string {
  if (pattern.length === 0 || pattern.length > 64) {
    throw new AppError("invalid_formula");
  }
  let index = 0;
  let output = "";
  let literal = "";
  const flush = (): void => {
    if (literal) {
      output += `"${literal.replace(/"/g, "")}"`;
      literal = "";
    }
  };
  while (index < pattern.length) {
    const match = FORMAT_TOKENS.find(([token]) =>
      pattern.startsWith(token, index),
    );
    if (match) {
      flush();
      output += match[1];
      index += match[0].length;
      continue;
    }
    const char = pattern[index] ?? "";
    if (/[\s:/.,-]/.test(char)) {
      flush();
      output += char;
    } else {
      literal += char;
    }
    index += 1;
  }
  flush();
  return output;
}

/** A number as text: optional sign, digits, a point, an exponent. */
const NUMERIC_TEXT = `'^\\s*[-+]?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d{1,4})?\\s*$'`;
const MYSQL_NUMERIC_TEXT = `'(?-i)^[[:space:]]*[-+]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][-+]?[0-9]{1,4})?[[:space:]]*$'`;

/** `YYYY-MM-DD`, then `T` or a space and `HH:MM[:SS[.ffffff]]`, then a zone. */
const ISO_DATETIME = `'^(\\d{4})-(\\d{2})-(\\d{2})(?:[T ](\\d{2}):(\\d{2})(?::(\\d{2})(\\.\\d{1,6})?)?)?\\s*(Z|([+-])(\\d{2})(?::?(\\d{2}))?)?$'`;

/**
 * Text read as an instant (ADR 0005), by AnyGridDB's grammar: ISO 8601, a
 * date, then optionally a time and a zone (`Z`, `±HH`, `±HH:MM`,
 * `±HHMM`). Text without a zone is in the zone `tz`. Anything else, a day
 * that does not exist included, is blank. Every cast reads digits the
 * pattern matched, and a nested case checks the date before building it.
 */
function postgresIsoInstant(text: string, tz: string): string {
  const int = (group: number) => `g[${String(group)}]::int`;
  const clock = (group: number) => `coalesce(${int(group)}, 0)`;
  const local = `make_timestamp(${int(1)}, ${int(2)}, ${int(3)}, ${clock(4)}, ${clock(5)}, ${clock(6)} + coalesce(('0' || g[7])::numeric, 0))`;
  const offset = `(case when g[9] = '-' then -1 else 1 end) * make_interval(hours => ${clock(10)}, mins => ${clock(11)})`;
  const valid = [
    `${int(3)} between 1 and extract(day from (make_date(${int(1)}, ${int(2)}, 1) + interval '1 month' - interval '1 day'))`,
    `${clock(4)} <= 23`,
    `${clock(5)} <= 59`,
    `${clock(6)} <= 59`,
    `${clock(10)} <= 23`,
    `${clock(11)} <= 59`,
  ].join(" and ");
  return `(select case when ${int(1)} >= 1 and ${int(2)} between 1 and 12 then case when ${valid} then case when g[8] is null then ${local} at time zone ${tz} else (${local} - ${offset}) at time zone 'UTC' end end end from (select regexp_match(btrim(${text}), ${ISO_DATETIME}) as g) p)`;
}

/** The same grammar on MySQL and MariaDB, whose patterns capture nothing. */
const MYSQL_ISO = `'(?-i)^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?)?[[:space:]]*(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$'`;

/**
 * Parts sit at fixed places once the pattern matched: the date at 1–10,
 * the time at 12–16, seconds at 18–19, a fraction after 20, then the zone.
 */
/**
 * A value named once and read many times, as a FROM item: `alias.column`.
 * MySQL reads it from a derived table; MariaDB's cannot see the outer
 * query, so it comes through JSON_TABLE, which can.
 */
function mysqlBound(
  name: "mysql" | "mariadb",
  sql: string,
  type: "double" | "longtext",
  alias: string,
): string {
  return name === "mysql"
    ? `(select ${sql} as v) ${alias}`
    : `json_table(json_array(${sql}), '$[*]' columns (v ${type} path '$')) ${alias}`;
}

function mysqlIsoInstant(
  name: "mysql" | "mariadb",
  text: string,
  tz: string,
): string {
  const s = `p.v`;
  const part = (from: number, length: number) =>
    `cast(substr(${s}, ${String(from)}, ${String(length)}) as unsigned)`;
  const hasTime = `(length(${s}) >= 16 and substr(${s}, 11, 1) in ('T', ' ') and substr(${s}, 14, 1) = ':')`;
  const hasSeconds = `(${hasTime} and substr(${s}, 17, 1) = ':')`;
  const fraction = `(case when ${hasSeconds} and substr(${s}, 20, 1) = '.' then regexp_substr(substr(${s}, 20), '^[.][0-9]{1,6}') else '' end)`;
  const end = `(case when ${hasSeconds} then 20 + length(${fraction}) when ${hasTime} then 17 else 11 end)`;
  const zone = `trim(substr(${s}, ${end}))`;
  const hour = `(case when ${hasTime} then ${part(12, 2)} else 0 end)`;
  const minute = `(case when ${hasTime} then ${part(15, 2)} else 0 end)`;
  const second = `(case when ${hasSeconds} then ${part(18, 2)} else 0 end)`;
  const local = `cast(concat(substr(${s}, 1, 10), ' ', lpad(${hour}, 2, '0'), ':', lpad(${minute}, 2, '0'), ':', lpad(${second}, 2, '0'), ${fraction}) as datetime(6))`;
  const compact = `replace(${zone}, ':', '')`;
  const offset = `(case when ${zone} = 'Z' then '+00:00' else concat(substr(${compact}, 1, 3), ':', if(length(${compact}) = 5, substr(${compact}, 4, 2), '00')) end)`;
  const valid = [
    `${part(1, 4)} >= 1000`,
    `${part(6, 2)} between 1 and 12`,
    `${part(9, 2)} between 1 and day(last_day(concat(substr(${s}, 1, 7), '-01')))`,
    `${hour} <= 23`,
    `${minute} <= 59`,
    `${second} <= 59`,
    `(${zone} in ('', 'Z') or (cast(substr(${compact}, 2, 2) as unsigned) <= 23 and (length(${compact}) = 3 or cast(substr(${compact}, 4, 2) as unsigned) <= 59)))`,
  ].join(" and ");
  return `(select case when ${s} regexp ${MYSQL_ISO} then case when ${valid} then case when ${zone} = '' then convert_tz(${local}, ${tz}, '+00:00') else convert_tz(${local}, ${offset}, '+00:00') end end end from ${mysqlBound(name, `trim(${text})`, "longtext", "p")})`;
}

/** MySQL's `date_format` field of each IS_SAME unit, the week aside. */
const MYSQL_UNIT_FORMAT: Record<TimeUnit, string> = {
  year: "%Y",
  month: "%Y-%m",
  week: "",
  day: "%Y-%m-%d",
  hour: "%Y-%m-%d %H",
  minute: "%Y-%m-%d %H:%i",
  second: "%Y-%m-%d %H:%i:%s",
};

const MYSQL_FORMAT_TOKENS: Array<[string, string | null]> = [
  ["YYYY", "%Y"],
  ["YY", "%y"],
  ["MMMM", "%M"],
  ["MMM", "%b"],
  ["MM", "%m"],
  ["M", "%c"],
  ["DD", "%d"],
  ["D", "%e"],
  ["dddd", "%W"],
  ["ddd", "%a"],
  ["HH", "%H"],
  ["H", "%k"],
  ["hh", "%h"],
  ["h", "%l"],
  ["mm", "%i"],
  ["ss", "%s"],
  ["A", "%p"],
  // MySQL has no lower-case am/pm.
  ["a", null],
];

/**
 * A `YYYY-MM-DD HH:mm` style pattern as MySQL `date_format` patterns, a
 * null where the lower-case am/pm goes: MySQL has only `%p`, upper case.
 */
export function mysqlDatePattern(pattern: string): Array<string | null> {
  if (pattern.length === 0 || pattern.length > 64) {
    throw new AppError("invalid_formula");
  }
  const parts: Array<string | null> = [];
  let output = "";
  for (let index = 0; index < pattern.length;) {
    const match = MYSQL_FORMAT_TOKENS.find(([token]) =>
      pattern.startsWith(token, index),
    );
    if (match) {
      const [token, field] = match;
      if (field === null) {
        if (output) parts.push(output);
        parts.push(null);
        output = "";
      } else {
        output += field;
      }
      index += token.length;
      continue;
    }
    const char = pattern[index] ?? "";
    output += char === "%" ? "%%" : char;
    index += 1;
  }
  if (output) parts.push(output);
  return parts;
}

/**
 * A list's values as a FROM item `alias(i, v)`: place, and value as text
 * (null for JSON null). MySQL's JSON_TABLE cannot read a list a correlated
 * subquery builds: it reads it from a derived table first, which can.
 */
function mysqlItems(
  name: "mysql" | "mariadb",
  list: string,
  alias: string,
): string {
  const table = (source: string) =>
    `json_table(${source}, '$[*]' columns (i for ordinality, v longtext path '$'))`;
  return name === "mariadb"
    ? `${table(list)} ${alias}`
    : `(select j.i, j.v from (select ${list} as l) l cross join ${table("l.l")} j) ${alias}`;
}

/** A portable pattern for MySQL and MariaDB: its case option written out. */
function mysqlPattern(regex: PortableRegex): string {
  return `${regex.caseless ? "(?i)" : "(?-i)"}${regex.pattern}`;
}

/** U+FFFF in UTF-8, as a literal that needs no backslash. */
const MYSQL_SENTINEL = "_utf8mb4 X'EFBFBF' collate utf8mb4_bin";

/** A list's value (text) back as the kind it was. */
function mysqlListValue(sql: string, kind: ScalarKind): string {
  switch (kind) {
    case "number":
      return `cast(${sql} as decimal(65,30))`;
    case "date":
      return `cast(${sql} as date)`;
    case "datetime":
      return `cast(replace(left(${sql}, char_length(${sql}) - 6), 'T', ' ') as datetime(6))`;
    case "boolean":
      return `(case when ${sql} = 'true' then true when ${sql} = 'false' then false end)`;
    default:
      return sql;
  }
}

/** A list's value (text) as the JSON it was: booleans bare, blanks null. */
function mysqlItemJson(sql: string, kind: ScalarKind): string {
  return kind === "boolean"
    ? `coalesce(${sql}, 'null')`
    : `coalesce(json_quote(${sql}), 'null')`;
}

/** One value of a list as JSON text: numbers canonical, as PostgreSQL's. */
function mysqlListElement(sql: string, kind: ScalarKind): string {
  switch (kind) {
    case "boolean":
      return `(case when ${sql} then 'true' when not ${sql} then 'false' end)`;
    case "number":
      return `json_quote(${mysqlNumberText(sql)})`;
    case "date":
      return `json_quote(date_format(${sql}, '%Y-%m-%d'))`;
    case "datetime":
      return `json_quote(${mysqlJson(sql, "datetime")})`;
    default:
      return `json_quote(${sql})`;
  }
}

/** A value as MySQL and MariaDB JSON: booleans as JSON, dates as text. */
function mysqlJson(sql: string, kind: JsonKind): string {
  switch (kind) {
    case "json":
      // Text of JSON (MariaDB has no JSON type) read back as JSON.
      return `json_extract(${sql}, '$')`;
    case "boolean":
      return `(case when ${sql} then json_extract('true', '$') when not ${sql} then json_extract('false', '$') end)`;
    case "datetime":
      // As PostgreSQL writes an instant in UTC: the fraction trimmed.
      return `concat(date_format(${sql}, '%Y-%m-%dT%H:%i:%s'), case when microsecond(${sql}) = 0 then '' else trim(trailing '0' from date_format(${sql}, '.%f')) end, '+00:00')`;
    case "date":
      return `date_format(${sql}, '%Y-%m-%d')`;
    default:
      return sql;
  }
}

/** The instant `sql` (UTC) as the wall clock of `tz`. */
function mysqlLocal(sql: string, tz: string): string {
  return `convert_tz(${sql}, '+00:00', ${tz})`;
}

function mysqlDialect(name: "mysql" | "mariadb"): SqlDialect {
  return {
    name,
    boolLiteral: (value) => (value ? "true" : "false"),
    cond: (sql) => sql,
    boolValue: (condition) => condition,
    truth: (condition) => `coalesce(${condition}, false)`,
    bitOf: (sql) => sql,
    zone: (iana) => iana,
    // A blank text is typed: in a prepared statement, CASE over NULL and a
    // bound text is binary, which JSON_OBJECT writes as base64.
    nullOf: (kind) => (kind === "text" ? "cast(null as char)" : "null"),
    numberParam: (placeholder) => `cast(${placeholder} as decimal(65,30))`,
    textParam: (placeholder) => placeholder,
    intParam: (placeholder) => `cast(${placeholder} as signed)`,
    count: (sql) => sql,
    numberText: mysqlNumberText,
    dateText: (sql) => `date_format(${sql}, '%Y-%m-%d')`,
    localDatetimeText: (sql, tz) =>
      `date_format(${mysqlLocal(sql, tz)}, '%Y-%m-%d %H:%i')`,
    localDate: (sql, tz) => `date(${mysqlLocal(sql, tz)})`,
    today: (tz) => `date(${mysqlLocal("utc_timestamp(6)", tz)})`,
    addDays: (date, days) => `date_add(${date}, interval ${days} day)`,
    addPeriod: (date, amount, unit) =>
      `date_add(${date}, interval ${String(amount)} ${unit})`,
    startOf: (date, unit) =>
      unit === "week"
        ? `date_sub(${date}, interval weekday(${date}) day)`
        : unit === "month"
          ? `date_sub(${date}, interval dayofmonth(${date}) - 1 day)`
          : `makedate(year(${date}), 1)`,
    daysBetween: (end, start) => `datediff(${end}, ${start})`,
    secondsBetween: (end, start) =>
      `timestampdiff(microsecond, ${start}, ${end}) / 1000000`,
    // Filters follow the source's collation (ADR 0005).
    like: (sql, pattern) => `${sql} like ${pattern} escape '\\'`,
    textList: (items, bind) =>
      items.length === 0 ? "null" : items.map((item) => bind(item)).join(", "),
    inTexts: (sql, list) => `${sql} in (${list})`,
    orderTerm: (sql, direction) => `(${sql} is null), ${sql} ${direction}`,
    optionPosition: (sql, list) => `nullif(field(${sql}, ${list}), 0)`,
    sortText: (sql) => sql,
    countWhere: (condition) => `sum(case when ${condition} then 1 else 0 end)`,
    json: mysqlJson,
    row: (entries) =>
      `json_object(${entries.map(([name, sql]) => `'${name}', ${sql}`).join(", ")}) as "ag_row"`,
    groupKey: (sql, kind) => `json_array(${mysqlJson(sql, kind)})`,
    emptyLinks: () => "'[]'",
    // GROUP_CONCAT keeps the order it is given, which JSON_ARRAYAGG does
    // not. The list is JSON text; `json` reads it back as JSON.
    linksAgg: ({ id, label, from, where, order }) =>
      `coalesce((select concat('[', group_concat(json_object('id', ${id}, 'label', ${label}) order by ${order.join(", ")} separator ','), ']') from ${from} where ${where}), '[]')`,
    linksLength: (sql) => `json_length(${sql})`,
    // JSON text compares as binary: labels fold case, as in PostgreSQL.
    firstLinkLabel: (sql) =>
      `lower(json_unquote(json_extract(${sql}, '$[0].label')))`,
    // JSON_TABLE in a correlated EXISTS reads wrong on MySQL: search the
    // labels and ids as JSON instead.
    linksLabelLike: (sql, pattern) =>
      `(json_search(lower(json_extract(${sql}, '$[*].label')), 'one', lower(${pattern}), '\\') is not null)`,
    linksIdIn: (sql, list) =>
      `(${list
        .split(", ")
        .map(
          (item) =>
            `json_contains(json_extract(${sql}, '$[*].id'), json_quote(${item}))`,
        )
        .join(" or ")})`,
    readColumn: (ref, fieldType, physical) => {
      const type = typeName(physical.type);
      // A JSON document (MySQL's JSON, MariaDB's LONGTEXT alias) shows as
      // its text: JSON_OBJECT would nest it as an object otherwise.
      if (
        (fieldType === "text" || fieldType === "long_text") &&
        (type === "json" || type === "longtext")
      ) {
        return `cast(${ref} as char)`;
      }
      if (fieldType !== "datetime") return ref;
      // TIMESTAMP reads in the session's zone, UTC; DATETIME has none:
      // it is in the source's.
      if (type !== "datetime" || physical.zone === "UTC") return ref;
      return `convert_tz(${ref}, ${zoneLiteral(physical.zone)}, '+00:00')`;
    },
    keyId: (columns) =>
      columns.length === 1
        ? `cast(${columns[0] ?? ""} as char)`
        : `cast(json_array(${columns.join(", ")}) as char)`,
    contentId: (_alias, columns) =>
      columns.length === 0
        ? unavailable("contentId")
        : `md5(json_array(${columns.join(", ")}))`,
    keyText: (sql) => `cast(${sql} as char)`,
    // Whole numbers the engine checked, written out: MySQL refuses a
    // bound LIMIT in a prepared statement in some versions.
    limitOffset: (limit, offset) => {
      if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) {
        throw new AppError("invalid_limit");
      }
      return ` limit ${String(limit)} offset ${String(offset)}`;
    },
    // ROLLUP gives every prefix and a grand total. Keys are JSON, never
    // SQL null, so a rolled-up key is the only null (MariaDB has no
    // GROUPING()).
    groupCounts: ({ keys, source, limit }) => {
      const names = Array.from(
        { length: keys },
        (_, index) => `"k${String(index)}"`,
      );
      const depth = names.map((name) => `(${name} is not null)`).join(" + ");
      const row = [
        ...names.map(
          (name, index) => `'k${String(index)}', json_extract(${name}, '$[0]')`,
        ),
        `'depth', "depth"`,
        `'count', "count"`,
      ];
      return `select json_object(${row.join(", ")}) as "ag_row" from (select ${names.join(", ")}, ${depth} as "depth", count(*) as "count" from (${source}) g group by ${names.join(", ")} with rollup) r where "k0" is not null limit ${String(Math.trunc(limit))}`;
    },
    groupAggregates: ({ keys, source, value, kind, limit }) => {
      const names = Array.from(
        { length: keys },
        (_, index) => `"k${String(index)}"`,
      );
      const row = [
        ...names.map(
          (name, index) => `'k${String(index)}', json_extract(${name}, '$[0]')`,
        ),
        `'a0', ${mysqlJson(`r."a0"`, kind)}`,
      ];
      return `select json_object(${row.join(", ")}) as "ag_row" from (select ${names.join(", ")}, ${value} as "a0" from (${source}) q group by ${names.join(", ")}) r order by ${names.join(", ")} limit ${String(Math.trunc(limit))}`;
    },
    exactText: (sql) => `cast(${sql} as char)`,
    median: exactMedian,
    stddev: (sql) => `stddev_samp(${sql})`,
    variance: (sql) => `var_samp(${sql})`,
    stddevPop: (sql) => `stddev_pop(${sql})`,
    variancePop: (sql) => `var_pop(${sql})`,
    numberLiteral: (placeholder, value) => {
      const [whole = "", fraction = ""] = value.replace(/^-/, "").split(".");
      const scale = Math.min(fraction.length, 30);
      const precision = Math.min(
        Math.max(whole.replace(/^0+/, "").length + scale, 1),
        65,
      );
      return `cast(${placeholder} as decimal(${String(Math.max(precision, scale))},${String(scale)}))`;
    },
    computedText: mysqlNumberText,
    // The session divides with 30 decimals (div_precision_increment).
    divide: (a, b) => `round(${a} / nullif(${b}, 0), 20)`,
    textToNumber: (sql) =>
      `(case when ${sql} regexp ${MYSQL_NUMERIC_TEXT} then cast(trim(${sql}) as decimal(65,30)) end)`,
    textToInstant: (text, tz) => mysqlIsoInstant(name, text, tz),
    wallClockInstant: (text, tz) => mysqlIsoInstant(name, text, tz),
    dateToInstant: (sql, tz) =>
      `convert_tz(cast(${sql} as datetime(6)), ${tz}, '+00:00')`,
    localTimestamp: mysqlLocal,
    dateTimestamp: (sql) => `cast(${sql} as datetime(6))`,
    now: () => "utc_timestamp(6)",
    datePart: (part, sql) => {
      switch (part) {
        case "dow":
          return `(dayofweek(${sql}) - 1)`;
        case "week":
          return `week(${sql}, 3)`;
        case "second":
          return `(second(${sql}) + microsecond(${sql}) / 1000000)`;
        default:
          return `extract(${part} from ${sql})`;
      }
    },
    monthsBetween: (end, start) => `timestampdiff(month, ${start}, ${end})`,
    addUnit: (sql, amount, unit) =>
      `date_add(${sql}, interval ${amount} ${unit})`,
    sameUnit: (a, b, unit) => {
      const key = (sql: string) =>
        unit === "week"
          ? `yearweek(${sql}, 3)`
          : `date_format(${sql}, '${MYSQL_UNIT_FORMAT[unit]}')`;
      return `(${key(a)} = ${key(b)})`;
    },
    formatTimestamp: (sql, pattern, bind) => {
      const parts = mysqlDatePattern(pattern).map((part) =>
        part === null
          ? `lower(date_format(${sql}, '%p'))`
          : `date_format(${sql}, ${bind(part)})`,
      );
      return parts.length === 1
        ? (parts[0] ?? "null")
        : `concat(${parts.join(", ")})`;
    },
    concatAll: (parts) => `concat_ws('', ${parts.join(", ")})`,
    trim: (sql) => `trim(${sql})`,
    locate: (needle, haystack, start, foldCase) => {
      // By code point, as PostgreSQL: a ci or ai collation would match
      // `e` with `É`.
      const exact = (sql: string) =>
        `convert(${foldCase ? `lower(${sql})` : sql} using utf8mb4) collate utf8mb4_bin`;
      return `(case when ${needle} is null or ${haystack} is null then null else locate(${exact(needle)}, ${exact(haystack)}, ${start}) end)`;
    },
    // PostgreSQL's OVERLAY: past the end, the text is appended (MySQL's
    // INSERT would leave the text as it was).
    overlay: (text, insert, start, length) =>
      `concat(left(${text}, ${start} - 1), ${insert}, substring(${text}, ${start} + ${length}))`,
    compareText: (a, symbol, b) =>
      `(convert(${a} using utf8mb4) collate utf8mb4_bin ${symbol} convert(${b} using utf8mb4) collate utf8mb4_bin)`,
    toInt: (sql) => `cast(${sql} as signed)`,
    clamp: (sql, low, high) =>
      `least(greatest(coalesce(${sql}, 0), ${String(low)}), ${String(high)})`,
    mod: (a, b) => `mod(${a}, nullif(${b}, 0))`,
    ceil: (sql) => `ceil(${sql})`,
    ln: (sql) => `ln(${sql})`,
    expCeiling: 80,
    textLength: (sql) => `char_length(${sql})`,
    // Not `<> ''`: a PAD SPACE collation (MariaDB's default) reads a
    // space as empty.
    textFilled: (sql) => `(char_length(${sql}) > 0)`,
    repeat: (sql, count) => `repeat(${sql}, ${count})`,
    replaceText: (text, search, replacement) =>
      `replace(${text}, ${search}, ${replacement})`,
    truncate: (sql, digits) => `truncate(${sql}, ${digits})`,
    log: (base, sql) => `log(${base}, ${sql})`,
    power: (base, exponent) => `power(${base}, ${exponent})`,
    // A double holds 15 significant digits reliably: rounded there, LOG of
    // 1000 reads 3, not 2.9999999999999996. EXP and POWER stop at e^80,
    // which decimal(65,30) holds.
    fromFloat: (sql) =>
      `(select round(cast(f.v as decimal(65,30)), coalesce(14 - floor(log10(abs(f.v))), 0)) from ${mysqlBound(name, sql, "double", "f")})`,
    roundUp: (sql, digits) =>
      `(case when ${sql} = truncate(${sql}, ${digits}) then ${sql} else truncate(${sql}, ${digits}) + sign(${sql}) * cast(concat('1e', -(${digits})) as decimal(65,30)) end)`,
    // A list is JSON text in order (GROUP_CONCAT keeps it; JSON_ARRAYAGG
    // does not), a blank kept as null.
    listAgg: ({ element, kind, from, where, order }) =>
      `coalesce((select concat('[', group_concat(coalesce(${mysqlListElement(element, kind)}, 'null') order by ${order.join(", ")} separator ','), ']') from ${from} where ${where}), '[]')`,
    joinAgg: ({ element, separator, from, where, order }) =>
      `(select group_concat(${element} order by ${order.join(", ")} separator ${separator}) from ${from} where ${where})`,
    emptyList: () => "'[]'",
    listLength: (sql) => `json_length(${sql})`,
    listTextLike: (sql, pattern) =>
      `(json_search(lower(${sql}), 'one', lower(${pattern}), '\\') is not null)`,
    listHas: (sql, test, items, bind) => {
      const contains = (item: string) =>
        `json_contains(${sql}, json_quote(${bind(item)}))`;
      const all = `(${items.map(contains).join(" and ")})`;
      switch (test) {
        case "any":
          return `coalesce(${items.map(contains).join(" or ")}, false)`;
        case "all":
          return `coalesce(${all}, false)`;
        case "none":
          return `(not coalesce(${items.map(contains).join(" or ")}, false))`;
        case "exactly": {
          const listed = `json_array(${items.map((item) => bind(item)).join(", ")})`;
          return `coalesce(json_contains(${sql}, ${listed}) and json_contains(${listed}, ${sql}), false)`;
        }
      }
    },
    listSortText: (sql) => `lower(cast(${sql} as char))`,
    // GROUP_CONCAT's separator must be written out: each value carries it
    // in front, and the first one is cut.
    listJoin: (list, alias, text, separator) =>
      `(select substring(group_concat(concat(${separator}, ${text}) order by ${alias}.i separator ''), char_length(${separator}) + 1) from ${mysqlItems(name, list, alias)})`,
    listInstant: (sql) =>
      `cast(replace(left(${sql}, char_length(${sql}) - 6), 'T', ' ') as datetime(6))`,
    // A value is kept where no earlier one is the same. MySQL reads the
    // earlier ones as a JSON range (its JSON_TABLE reads wrong in a
    // correlated EXISTS); MariaDB before 10.9 has no ranges, and its
    // JSON_TABLE reads right.
    listUnique: (list, kind) =>
      `(select concat('[', coalesce(group_concat(${mysqlItemJson("a.v", kind)} order by a.i separator ','), ''), ']') from ${mysqlItems(name, list, "a")} where ${
        name === "mysql"
          ? `a.i = 1 or not json_contains(json_extract(${list}, concat('$[0 to ', a.i - 2, ']')), json_extract(${list}, concat('$[', a.i - 1, ']')))`
          : `not exists (select 1 from ${mysqlItems(name, list, "b")} where b.i < a.i and (binary b.v = binary a.v or (b.v is null and a.v is null)))`
      })`,
    listCompact: (list, kind) =>
      `(select concat('[', coalesce(group_concat(${mysqlItemJson("u.v", kind)} order by u.i separator ','), ''), ']') from ${mysqlItems(name, list, "u")} where char_length(u.v) > 0)`,
    listSum: (list) =>
      `(select sum(cast(u.v as decimal(65,30))) from ${mysqlItems(name, list, "u")})`,
    // MySQL's derived table reads the row before it only when LATERAL.
    listItemsJoin: (list, alias) =>
      `cross join ${name === "mysql" ? "lateral " : ""}${mysqlItems(name, list, alias)}`,
    listValue: mysqlListValue,
    listFrom: (list, alias) => mysqlItems(name, list, alias),
    listOne: (sql, kind) =>
      `concat('[', coalesce(${mysqlListElement(sql, kind)}, 'null'), ']')`,
    // The delimiter becomes U+FFFF, a noncharacter no text carries and
    // JSON_QUOTE leaves as it is; then each one closes a value and opens
    // the next. REPLACE matches exactly, whatever the collation.
    textSplit: (text, delimiter) => {
      const bin = (sql: string) =>
        `convert(${sql} using utf8mb4) collate utf8mb4_bin`;
      const marked = `replace(${bin(text)}, ${bin(delimiter)}, ${MYSQL_SENTINEL})`;
      return `(case when ${text} is null then null when char_length(${text}) = 0 then '[]' when char_length(coalesce(${delimiter}, '')) = 0 then concat('[', json_quote(${text}), ']') else concat('[', replace(${bin(`json_quote(${marked})`)}, ${MYSQL_SENTINEL}, ${bin(`'","'`)}), ']') end)`;
    },
    listSort: (list, kind, descending) => {
      const key =
        kind === "text"
          ? "convert(u.v using utf8mb4) collate utf8mb4_bin"
          : mysqlListValue("u.v", kind);
      return `(select concat('[', coalesce(group_concat(${mysqlItemJson("u.v", kind)} order by (u.v is null), ${key} ${descending ? "desc" : "asc"}, u.i separator ','), ''), ']') from ${mysqlItems(name, list, "u")})`;
    },
    listSlice: (list, kind, from, to) =>
      `(select concat('[', coalesce(group_concat(${mysqlItemJson("u.v", kind)} order by u.i separator ','), ''), ']') from ${mysqlItems(name, list, "u")} where u.i >= ${from} and u.i <= ${to})`,
    listConcat: (lists) =>
      lists.length === 1
        ? (lists[0] ?? "'[]'")
        : `cast(json_merge_preserve(${lists.map((list) => `coalesce(${list}, '[]')`).join(", ")}) as char)`,
    jsonObject: (entries) =>
      `json_object(${entries.map(([key, sql]) => `'${key}', ${sql}`).join(", ")})`,
    // MariaDB's derived tables cannot read the outer row; JSON_TABLE can.
    boundRow: (values, alias) =>
      name === "mysql"
        ? boundSelect(values, alias)
        : `json_table(json_array(${values.map((value) => value.sql).join(", ")}), '$' columns (${values.map((value, index) => `${value.name} ${value.type} path '$[${String(index)}]'`).join(", ")})) ${alias}`,
    listAggregate: (list, fn, kind) =>
      fn === "counta"
        ? `(select count(*) from ${mysqlItems(name, list, "u")} where char_length(u.v) > 0)`
        : `(select ${fn}(${mysqlListValue("u.v", fn === "min" || fn === "max" ? kind : "number")}) from ${mysqlItems(name, list, "u")})`,
    encodeUrl: (sql) => mysqlEncodeUrl(name, sql),
    // The text's bytes in UTF-8, whatever its column's character set.
    hashHex: (sql, algorithm) => {
      const bytes = `convert(${sql} using utf8mb4)`;
      return algorithm === "md5"
        ? `md5(${bytes})`
        : `sha2(${bytes}, ${algorithm === "sha256" ? "256" : "512"})`;
    },
    textFrom: (sql, start) => `substring(${sql}, ${start})`,
    // The case option comes first: a case-insensitive collation would
    // make the match ignore case otherwise. MySQL's ICU names a group `$1`,
    // MariaDB's PCRE2 `\1`.
    regexMatch: (sql, regex, bind) =>
      `(${sql} regexp ${bind(mysqlPattern(regex))})`,
    regexExtract: (sql, regex, bind) => {
      const pattern = bind(mysqlPattern(regex));
      // MariaDB's REGEXP_SUBSTR reads '' when nothing matches.
      return `(case when ${sql} regexp ${pattern} then regexp_substr(${sql}, ${pattern}) end)`;
    },
    regexReplace: (sql, regex, replacement, bind) => {
      const written =
        "sql" in replacement
          ? name === "mysql"
            ? `replace(replace(${replacement.sql}, '\\', '\\\\'), '$', '\\$')`
            : `replace(${replacement.sql}, '\\', '\\\\')`
          : bind(
              replacement
                .map((part) =>
                  "text" in part
                    ? name === "mysql"
                      ? part.text.replace(/[\\$]/g, (sign) => `\\${sign}`)
                      : part.text.replace(/\\/g, "\\\\")
                    : name === "mysql"
                      ? `$${String(part.group)}`
                      : `\\${String(part.group)}`,
                )
                .join(""),
            );
      return `regexp_replace(${sql}, ${bind(mysqlPattern(regex))}, ${written})`;
    },
    // Text that is not JSON becomes null before JSON_EXTRACT, which the
    // optimizer may run ahead on a constant. CONVERT keeps a bound value
    // text: a prepared statement would type it JSON from its place, and
    // cast it on binding.
    jsonExtract: (sql, path, bind) => {
      const text = `convert(${sql} using utf8mb4)`;
      const found = `json_extract((case when json_valid(${text}) then ${text} end), ${bind(jsonPathText(path))})`;
      return `(case when json_type(${found}) = 'NULL' then null else json_unquote(${found}) end)`;
    },
    exactTextKey: (sql) => `convert(${sql} using utf8mb4) collate utf8mb4_bin`,
    unavailable,
  };
}

export const MYSQL = mysqlDialect("mysql");
export const MARIADB = mysqlDialect("mariadb");

/** The dialect a table's rows are read in. */
export function dialectOf(table: EngineTable): SqlDialect {
  const dialect = baseDialect(table);
  return table.serverVersion
    ? { ...dialect, version: table.serverVersion }
    : dialect;
}

function baseDialect(table: EngineTable): SqlDialect {
  switch (table.external?.dialect) {
    case "mysql":
      return MYSQL;
    case "mariadb":
      return MARIADB;
    case "sqlserver":
      return SQLSERVER;
    default:
      return POSTGRES;
  }
}
