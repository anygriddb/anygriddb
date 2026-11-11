/**
 * Oracle's dialect (ADRs 0005, 0047), for 19c and later. Empty text is
 * NULL: a blank text is unknown, never an empty string. Conditions are not
 * values (a flag is NUMBER(1) compared to 1). Pages use OFFSET … FETCH;
 * rows and lists are JSON built by JSON_OBJECT and JSON_ARRAYAGG, read back
 * by JSON_VALUE and JSON_TABLE. Identifiers stay double-quoted. Each
 * session reads in UTC and compares text by code point (sources/oracle.ts).
 * Regular expressions are refused: Oracle's lack what the portable subset
 * needs (`regex.ts`).
 */
import { AppError } from "../errors";
import { isTimeZone } from "../field-config";
import type { ScalarKind } from "./expressions";
import type {
  Bind,
  JsonKind,
  SortDirection,
  SqlDialect,
  TimeUnit,
  WallClockShape,
  HashAlgorithm,
} from "./dialect";
import { jsonPathText } from "./json-path";
import { withoutGroups } from "../plain-text";

const unavailable = (what: string): never => {
  throw new AppError("function_unavailable", what);
};

function zoneLiteral(zone: string): string {
  if (!isTimeZone(zone)) throw new AppError("invalid_input");
  return `'${zone}'`;
}

/** `number(14,2)` reads as `number`. */
function typeName(type: string): string {
  return withoutGroups(type.toLowerCase()).replace(/\s+/g, " ").trim();
}

/**
 * Text compared by code point: each session's NLS_COMP and NLS_SORT are
 * BINARY (sources/oracle.ts), the order of UTF-8 bytes.
 */
function binary(sql: string): string {
  return sql;
}

/** A number as its shortest exact text. */
function numberText(sql: string): string {
  return `(case when ${sql} is null then null else ${decimalText(`to_char(${sql}, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')`)} end)`;
}

/** TO_CHAR writes `.25` and `-.5`: the zero before the point put back. */
function decimalText(text: string): string {
  return `regexp_replace(trim(${text}), '^(-?)\\.', '\\10.')`;
}

/** An instant as PostgreSQL writes it in UTC. */
function instantText(sql: string): string {
  return `(case when ${sql} is null then null else to_char(cast(${sql} as timestamp with time zone) at time zone '+00:00', 'YYYY-MM-DD"T"HH24:MI:SS') || case when to_char(cast(${sql} as timestamp), 'FF6') = '000000' then '' else '.' || rtrim(to_char(cast(${sql} as timestamp), 'FF6'), '0') end || '+00:00' end)`;
}

/**
 * The same day `months` later, or that month's last day; a timestamp
 * keeps its time of day. ADD_MONTHS would move a month's last day to the
 * next month's last, and an interval fails on a day the month lacks.
 */
function monthsLater(sql: string, months: string, date: boolean): string {
  const first = `add_months(trunc(${sql}, 'MM'), ${months})`;
  const day = `least(extract(day from ${sql}), extract(day from last_day(${first})))`;
  const moved = `(${first} + (${day} - 1))`;
  return date
    ? moved
    : `(cast(${moved} as timestamp(6)) + (cast(${sql} as timestamp(6)) - cast(trunc(${sql}) as timestamp(6))))`;
}

/** The instant `sql` (UTC) as the wall clock of `tz`, SQL for a zone name. */
function local(sql: string, tz: string): string {
  return `cast(from_tz(cast(${sql} as timestamp), '+00:00') at time zone (${tz}) as timestamp(6))`;
}

/**
 * A value as JSON, inside a JSON_OBJECT's VALUE: JSON text kept as JSON,
 * flags as true and false.
 */
function json(sql: string, kind: JsonKind): string {
  switch (kind) {
    case "json":
      return `${sql} format json`;
    case "boolean":
      return `(case when ${sql} = 1 then 'true' when ${sql} = 0 then 'false' end) format json`;
    case "datetime":
      return instantText(sql);
    case "date":
      return `to_char(${sql}, 'YYYY-MM-DD')`;
    default:
      return sql;
  }
}

/** A text as a JSON string (`"a\"b"`), NULL for NULL: JSON_ARRAY escapes it. */
function jsonString(sql: string): string {
  return `(case when ${sql} is null then null else regexp_replace(json_array(${sql}), '^\\[(.*)\\]$', '\\1', 1, 1, 'n') end)`;
}

/** A group key: JSON text, never NULL, so ROLLUP's own nulls stand out. */
function groupKey(sql: string, kind: JsonKind): string {
  const text =
    kind === "json"
      ? sql
      : kind === "boolean"
        ? `(case when ${sql} = 1 then 'true' when ${sql} = 0 then 'false' end)`
        : kind === "number"
          ? numberText(sql)
          : jsonString(
              kind === "datetime"
                ? instantText(sql)
                : kind === "date"
                  ? `to_char(${sql}, 'YYYY-MM-DD')`
                  : sql,
            );
  return `coalesce(${text}, 'null')`;
}

function items(list: string): string[] {
  return list === "null" ? [] : list.split(", ");
}

/**
 * A list's items as rows `alias(i, v, j)`: place, value as text (NULL for
 * a JSON null), and the item as JSON, to aggregate again as it was.
 */
function openItems(list: string, alias: string): string {
  return `json_table(${list}, '$[*]' columns (i for ordinality, v varchar2(4000) path '$', j varchar2(4000) format json path '$')) ${alias}`;
}

/** Items `alias.j` back as a JSON array, in `order`; `[]` for none. */
function arrayOf(alias: string, order: string, from: string): string {
  return `coalesce((select json_arrayagg(${alias}.j format json order by ${order} null on null returning clob) from ${from}), to_clob('[]'))`;
}

function listValue(sql: string, kind: ScalarKind): string {
  switch (kind) {
    case "number":
      return `to_number(${sql})`;
    case "date":
      return `to_date(${sql}, 'YYYY-MM-DD')`;
    case "datetime":
      return `cast(to_timestamp_tz(${sql}, 'YYYY-MM-DD"T"HH24:MI:SS.FFTZH:TZM') at time zone 'UTC' as timestamp(6))`;
    case "boolean":
      return `(case when ${sql} = 'true' then 1 when ${sql} = 'false' then 0 end)`;
    default:
      return sql;
  }
}

/** A list item as JSON_ARRAYAGG takes it: decimals as strings, as reads do. */
function listElement(sql: string, kind: ScalarKind): string {
  switch (kind) {
    case "boolean":
      return `(case when ${sql} = 1 then 'true' when ${sql} = 0 then 'false' end) format json`;
    case "number":
      return numberText(sql);
    case "date":
      return `to_char(${sql}, 'YYYY-MM-DD')`;
    case "datetime":
      return instantText(sql);
    default:
      return sql;
  }
}

const DIGIT = "[0-9]";
const DATE = `${DIGIT}${DIGIT}${DIGIT}${DIGIT}-${DIGIT}${DIGIT}-${DIGIT}${DIGIT}`;
const NUMERIC_TEXT = `'^[[:space:]]*[-+]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][-+]?[0-9]{1,4})?[[:space:]]*$'`;

/** Wall-clock shapes matched without REGEXP when possible. */
function wallClockInstant(
  sql: string,
  tz: string,
  shape: WallClockShape,
): string {
  const pattern =
    shape === "date"
      ? DATE
      : shape === "minute"
        ? `${DATE} ${DIGIT}${DIGIT}:${DIGIT}${DIGIT}`
        : `${DATE} ${DIGIT}${DIGIT}:${DIGIT}${DIGIT}:${DIGIT}${DIGIT}`;
  const format =
    shape === "date"
      ? "YYYY-MM-DD"
      : shape === "minute"
        ? "YYYY-MM-DD HH24:MI"
        : "YYYY-MM-DD HH24:MI:SS";
  // A day the month lacks reads as nothing, as on the other engines.
  const local = `to_timestamp(${sql} default null on conversion error, '${format}')`;
  return `(case when regexp_like(${sql}, '^${pattern}$') then cast(from_tz(${local}, ${tz}) at time zone 'UTC' as timestamp(6)) end)`;
}

/**
 * ISO 8601 as the other engines read it: a date, then a time to the
 * microsecond, then `Z` or an offset; nine groups at most, which is all
 * REGEXP_SUBSTR returns. 1 date, 2 time, 4 fraction, 5 zone.
 */
const ISO = `'^([0-9]{4}-[0-9]{2}-[0-9]{2})([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?)?[[:space:]]*(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$'`;

/** Text read as an instant, in the zone `tz` when it names none. */
function isoInstant(text: string, tz: string): string {
  const part = (group: number) =>
    `regexp_substr(x.v, ${ISO}, 1, 1, null, ${String(group)})`;
  const clock = `p.d || ' ' || nvl(substr(p.t, 2, 2), '00') || ':' || nvl(substr(p.t, 5, 2), '00') || ':' || nvl(substr(p.t, 8, 2), '00') || '.' || nvl(substr(p.f, 2), '0')`;
  const local = `to_timestamp(${clock} default null on conversion error, 'YYYY-MM-DD HH24:MI:SS.FF')`;
  const zone = `(case when p.z is null then ${tz} when p.z = 'Z' then '+00:00' else substr(p.z, 1, 3) || ':' || nvl(substr(replace(p.z, ':'), 4, 2), '00') end)`;
  const offsetValid = `(p.z is null or p.z = 'Z' or (to_number(substr(p.z, 2, 2)) <= 23 and nvl(to_number(substr(replace(p.z, ':'), 4, 2)), 0) <= 59))`;
  return `(select case when p.d is not null and ${offsetValid} then cast(from_tz(${local}, ${zone}) at time zone 'UTC' as timestamp(6)) end from (select ${part(1)} as d, ${part(2)} as t, ${part(4)} as f, ${part(5)} as z from (select trim(${text}) as v from dual) x) p)`;
}

/** Tokens of a format, as TO_CHAR writes them: FM drops padding. */
const FORMAT_TOKENS: Array<[string, string]> = [
  ["YYYY", "YYYY"],
  ["YY", "YY"],
  ["MMMM", "FMMonth"],
  ["MMM", "FMMon"],
  ["MM", "MM"],
  ["M", "FMMM"],
  ["DD", "DD"],
  ["D", "FMDD"],
  ["dddd", "FMDay"],
  ["ddd", "FMDy"],
  ["HH", "HH24"],
  ["H", "FMHH24"],
  ["hh", "HH12"],
  ["h", "FMHH12"],
  ["mm", "MI"],
  ["ss", "SS"],
  ["A", "AM"],
  ["a", "AM"],
];

function formatTimestamp(sql: string, pattern: string, bind: Bind): string {
  if (pattern.length === 0 || pattern.length > 64) {
    throw new AppError("invalid_formula");
  }
  const parts: string[] = [];
  let literal = "";
  for (let index = 0; index < pattern.length;) {
    const match = FORMAT_TOKENS.find(([token]) =>
      pattern.startsWith(token, index),
    );
    if (!match) {
      literal += pattern[index] ?? "";
      index += 1;
      continue;
    }
    if (literal) parts.push(bind(literal));
    literal = "";
    const [token, format] = match;
    const formatted = `to_char(${sql}, '${format}')`;
    parts.push(token === "a" ? `lower(${formatted})` : formatted);
    index += match[0].length;
  }
  if (literal) parts.push(bind(literal));
  return `(case when ${sql} is null then null else ${parts.join(" || ")} end)`;
}

const UNRESERVED =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.~-";

function encodeUrl(sql: string): string {
  let encoded = `regexp_replace(rawtohex(convert(${sql}, 'AL32UTF8')), '(..)', '%\\1')`;
  for (const char of UNRESERVED) {
    const hex = char.charCodeAt(0).toString(16).toUpperCase();
    encoded = `replace(${encoded}, '%${hex}', '${char}')`;
  }
  return encoded;
}

function hashHex(sql: string, algorithm: HashAlgorithm): string {
  const kind =
    algorithm === "md5" ? "MD5" : algorithm === "sha256" ? "SHA256" : "SHA512";
  return `(case when ${sql} is not null then lower(rawtohex(standard_hash(convert(${sql}, 'AL32UTF8'), '${kind}'))) end)`;
}

export const ORACLE: SqlDialect = {
  name: "oracle",
  boolLiteral: (value) => (value ? "1" : "0"),
  cond: (sql) => `(${sql} = 1)`,
  boolValue: (condition) =>
    `(case when ${condition} then 1 when not (${condition}) then 0 end)`,
  truth: (condition) => `((case when ${condition} then 1 else 0 end) = 1)`,
  bitOf: (sql) =>
    `(case when ${sql} is null then null when ${sql} = 0 then 0 else 1 end)`,
  zone: (iana) => {
    if (!isTimeZone(iana)) return unavailable(`time zone ${iana}`);
    return iana;
  },
  nullOf: (kind) =>
    kind === "boolean"
      ? "cast(null as number(1))"
      : kind === "number"
        ? "cast(null as number)"
        : kind === "date"
          ? "cast(null as date)"
          : kind === "datetime"
            ? "cast(null as timestamp(6))"
            : "cast(null as varchar2(4000))",
  numberParam: (placeholder) => `to_number(${placeholder})`,
  textParam: (placeholder) => placeholder,
  intParam: (placeholder) => `to_number(${placeholder})`,
  count: (sql) => sql,
  numberText,
  dateText: (sql) => `to_char(${sql}, 'YYYY-MM-DD')`,
  localDatetimeText: (sql, tz) =>
    `to_char(${local(sql, tz)}, 'YYYY-MM-DD HH24:MI')`,
  localDate: (sql, tz) => `trunc(cast(${local(sql, tz)} as date))`,
  today: (tz) => `trunc(cast(systimestamp at time zone (${tz}) as date))`,
  addDays: (date, days) => `(${date} + ${days})`,
  addPeriod: (date, amount, unit) =>
    monthsLater(date, String(unit === "month" ? amount : amount * 12), true),
  startOf: (date, unit) =>
    unit === "week"
      ? `(${date} - mod(to_number(to_char(${date}, 'D')) + 5, 7))`
      : unit === "month"
        ? `trunc(${date}, 'MM')`
        : `trunc(${date}, 'YYYY')`,
  daysBetween: (end, start) => `(${end} - ${start})`,
  secondsBetween: (end, start) =>
    `(extract(day from (${end} - ${start})) * 86400 + extract(hour from (${end} - ${start})) * 3600 + extract(minute from (${end} - ${start})) * 60 + extract(second from (${end} - ${start})))`,
  // Case folded, as PostgreSQL's ILIKE; a blank matches nothing, and its
  // negation keeps it.
  like: (sql, pattern) =>
    `((case when lower(${sql}) like lower(${pattern}) escape '\\' then 1 else 0 end) = 1)`,
  textList: (list, bind) =>
    list.length === 0 ? "null" : list.map((item) => bind(item)).join(", "),
  inTexts: (sql, list) => `${sql} in (${list})`,
  orderTerm: (sql, direction: SortDirection) =>
    `(case when ${sql} is null then 1 else 0 end), ${sql} ${direction}`,
  optionPosition: (sql, list) =>
    `(case ${sql} ${items(list)
      .map((item, index) => `when ${item} then ${String(index + 1)}`)
      .join(" ")} end)`,
  sortText: (sql) => sql,
  countWhere: (condition) => `sum(case when ${condition} then 1 else 0 end)`,
  json,
  row: (entries) =>
    `json_object(${entries.map(([name, sql]) => `'${name}' value ${sql}`).join(", ")} returning clob) as "ag_row"`,
  groupKey,
  emptyLinks: () => "to_clob('[]')",
  linksAgg: ({ id, label, from, where, order }) =>
    `coalesce((select json_arrayagg(json_object('id' value ${id}, 'label' value ${label}) order by ${order.join(", ")} returning clob) from ${from} where ${where}), to_clob('[]'))`,
  linksLength: (sql) =>
    `(select count(*) from json_table(${sql}, '$[*]' columns (x varchar2(1) path '$')))`,
  firstLinkLabel: (sql) => `lower(json_value(${sql}, '$[0].label'))`,
  linksLabelLike: (sql, pattern) =>
    `exists (select 1 from json_table(${sql}, '$[*]' columns (label varchar2(4000) path '$.label')) e where lower(e.label) like lower(${pattern}) escape '\\')`,
  linksIdIn: (sql, list) =>
    `exists (select 1 from json_table(${sql}, '$[*]' columns (id varchar2(1000) path '$.id')) e where e.id in (${list}))`,
  readColumn: (ref, fieldType, physical) => {
    const type = typeName(physical.type);
    if (
      type === "binary_float" ||
      type === "binary_double" ||
      type === "float"
    ) {
      return `cast(${ref} as number(38,10))`;
    }
    // A DATE also holds a time of day: a date field reads the day alone.
    if (fieldType === "date") return `trunc(${ref})`;
    if (fieldType !== "datetime") return ref;
    if (type === "timestamp with time zone") {
      return `cast(${ref} at time zone 'UTC' as timestamp(6))`;
    }
    if (type === "timestamp with local time zone") {
      return `cast(${ref} at time zone 'UTC' as timestamp(6))`;
    }
    if (physical.zone === "UTC") return `cast(${ref} as timestamp(6))`;
    return `cast(from_tz(cast(${ref} as timestamp), ${zoneLiteral(physical.zone)}) at time zone 'UTC' as timestamp(6))`;
  },
  // trunc() would keep a filter off the column's index; a DATE or a
  // TIMESTAMP without a zone compares with midnight bounds as stored.
  comparesStoredDay: (fieldType, physical) =>
    fieldType === "date" &&
    ["date", "timestamp"].includes(typeName(physical.type)),
  keyId: (columns) =>
    columns.length === 1
      ? `cast(${columns[0] ?? ""} as varchar2(1000))`
      : // Joined to '' so JSON_OBJECT takes it as text, not as a list.
        `('' || json_serialize(json_array(${columns.join(", ")})))`,
  contentId: (_alias, columns) =>
    columns.length === 0
      ? unavailable("contentId")
      : `lower(rawtohex(standard_hash(json_serialize(json_array(${columns.join(", ")})), 'MD5')))`,
  keyText: (sql) => `cast(${sql} as varchar2(1000))`,
  limitOffset: (limit, offset, _bind) => {
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) {
      throw new AppError("invalid_limit");
    }
    return ` offset ${String(offset)} rows fetch next ${String(limit)} rows only`;
  },
  groupCounts: ({ keys, source, limit, bind: _bind }) => {
    const names = Array.from(
      { length: keys },
      (_, index) => `"k${String(index)}"`,
    );
    const depth = names
      .map((name) => `(case when grouping(${name}) = 0 then 1 else 0 end)`)
      .join(" + ");
    const row = [
      ...names.map(
        (name, index) => `'k${String(index)}' value g2.${name} format json`,
      ),
      `'depth' value g2."depth"`,
      `'count' value g2."count"`,
    ];
    const sets = names.map(
      (_, index) => `(${names.slice(0, index + 1).join(", ")})`,
    );
    return `select json_object(${row.join(", ")} returning clob) as "ag_row" from (select ${names.join(", ")}, ${depth} as "depth", count(*) as "count" from (${source}) g group by grouping sets (${sets.join(", ")})) g2 fetch first ${String(Math.trunc(limit))} rows only`;
  },
  groupAggregates: ({ keys, source, value, kind, limit, bind: _bind }) => {
    const names = Array.from(
      { length: keys },
      (_, index) => `"k${String(index)}"`,
    );
    const row = [
      ...names.map(
        (name, index) => `'k${String(index)}' value g2.${name} format json`,
      ),
      `'a0' value ${json(`g2."a0"`, kind)}`,
    ];
    return `select json_object(${row.join(", ")} returning clob) as "ag_row" from (select ${names.join(", ")}, ${value} as "a0" from (${source}) q group by ${names.join(", ")}) g2 order by ${names.map((name) => `g2.${name}`).join(", ")} fetch first ${String(Math.trunc(limit))} rows only`;
  },
  // MEDIAN is exact on NUMBER, and an aggregate: Oracle takes no scalar
  // subquery beside COUNT(*) in a query without GROUP BY (ORA-00937).
  median: (sql) => `median(${sql})`,
  stddev: (sql) => `stddev_samp(${sql})`,
  variance: (sql) => `var_samp(${sql})`,
  stddevPop: (sql) => `stddev_pop(${sql})`,
  variancePop: (sql) => `var_pop(${sql})`,
  exactText: (sql) => decimalText(`to_char(${sql})`),
  numberLiteral: (_placeholder, value) => {
    if (!/^-?\d+(\.\d+)?$/.test(value)) throw new AppError("invalid_formula");
    const [whole = "", fraction = ""] = value.replace(/^-/, "").split(".");
    const scale = Math.min(fraction.length, 38);
    const precision = Math.min(
      Math.max(whole.replace(/^0+/, "").length + scale, 1, scale),
      38,
    );
    return `cast(${value} as number(${String(precision)},${String(scale)}))`;
  },
  computedText: numberText,
  divide: (a, b) => `round(${a} / nullif(${b}, 0), 20)`,
  textToNumber: (sql) =>
    `(case when regexp_like(trim(${sql}), ${NUMERIC_TEXT}) then to_number(trim(${sql})) end)`,
  textToInstant: isoInstant,
  wallClockInstant,
  dateToInstant: (sql, tz) =>
    `cast(from_tz(cast(${sql} as timestamp), ${tz}) at time zone 'UTC' as timestamp(6))`,
  localTimestamp: local,
  dateTimestamp: (sql) => `cast(${sql} as timestamp(6))`,
  now: () => "cast(systimestamp at time zone 'UTC' as timestamp(6))",
  datePart: (part, sql) => {
    switch (part) {
      // The session's territory is AMERICA: 'D' is 1 on Sunday.
      case "dow":
        return `(to_number(to_char(${sql}, 'D')) - 1)`;
      case "week":
        return `to_number(to_char(${sql}, 'IW'))`;
      case "second":
        return `to_number(to_char(cast(${sql} as timestamp), 'SS.FF6'))`;
      default:
        return `extract(${part} from cast(${sql} as timestamp))`;
    }
  },
  // Whole calendar months, less one when the end's day and time in its
  // month come before the start's (MONTHS_BETWEEN counts fractions).
  monthsBetween: (end, start) =>
    `(select case when m.e >= m.s then m.d - (case when m.oe < m.os then 1 else 0 end) else m.d + (case when m.oe > m.os then 1 else 0 end) end from (select x.e, x.s, (extract(year from x.e) * 12 + extract(month from x.e)) - (extract(year from x.s) * 12 + extract(month from x.s)) as d, x.e - cast(trunc(x.e, 'MM') as timestamp(6)) as oe, x.s - cast(trunc(x.s, 'MM') as timestamp(6)) as os from (select cast(${end} as timestamp(6)) as e, cast(${start} as timestamp(6)) as s from dual) x) m)`,
  addUnit: (sql, amount, unit, date) => {
    const interval =
      unit === "second"
        ? `numtodsinterval(${amount}, 'SECOND')`
        : unit === "minute"
          ? `numtodsinterval(${amount}, 'MINUTE')`
          : unit === "hour"
            ? `numtodsinterval(${amount}, 'HOUR')`
            : unit === "day"
              ? `numtodsinterval(${amount}, 'DAY')`
              : `numtodsinterval(7 * ${amount}, 'DAY')`;
    if (unit === "month" || unit === "year") {
      return monthsLater(
        sql,
        unit === "month" ? amount : `12 * ${amount}`,
        date,
      );
    }
    return date
      ? `cast((${sql} + ${interval}) as date)`
      : `(${sql} + ${interval})`;
  },
  sameUnit: (a, b, unit: TimeUnit) => {
    const fmt =
      unit === "year"
        ? "YYYY"
        : unit === "month"
          ? "YYYY-MM"
          : unit === "week"
            ? "IYYY-IW"
            : unit === "day"
              ? "YYYY-MM-DD"
              : unit === "hour"
                ? "YYYY-MM-DD HH24"
                : unit === "minute"
                  ? "YYYY-MM-DD HH24:MI"
                  : "YYYY-MM-DD HH24:MI:SS";
    return `(to_char(${a}, '${fmt}') = to_char(${b}, '${fmt}'))`;
  },
  formatTimestamp,
  concatAll: (parts) =>
    parts.length <= 1 ? (parts[0] ?? "null") : `(${parts.join(" || ")})`,
  trim: (sql) => `trim(${sql})`,
  locate: (needle, haystack, start, foldCase) => {
    const fold = (s: string) => (foldCase ? `lower(${s})` : s);
    return `(case when ${needle} is null or ${haystack} is null then null when length(${needle}) = 0 then ${start} else coalesce(nullif(instr(${fold(haystack)}, ${fold(needle)}, ${start}), 0), 0) end)`;
  },
  overlay: (text, insert, start, length) =>
    `(case when ${text} is null then null else substr(${text}, 1, ${start} - 1) || ${insert} || substr(${text}, ${start} + ${length}) end)`,
  compareText: (a, symbol, b) => {
    const [x, y] = [binary(a), binary(b)];
    return `(${x} ${symbol} ${y})`;
  },
  toInt: (sql) => `round(${sql})`,
  clamp: (sql, low, high) => {
    const value = `coalesce(${sql}, 0)`;
    return `(case when ${value} < ${String(low)} then ${String(low)} when ${value} > ${String(high)} then ${String(high)} else ${value} end)`;
  },
  mod: (a, b) => `mod(${a}, nullif(${b}, 0))`,
  ceil: (sql) => `ceil(${sql})`,
  ln: (sql) => `ln(${sql})`,
  expCeiling: 80,
  textLength: (sql) => `length(${sql})`,
  textFilled: (sql) => `(${sql} is not null)`,
  repeat: (sql, count) =>
    `substr(replace(rpad('x', to_number(${count}) + 1, 'x'), 'x', ${sql}), 1, length(${sql}) * to_number(${count}))`,
  replaceText: (text, search, replacement) =>
    `replace(${text}, ${search}, ${replacement})`,
  truncate: (sql, digits) => `trunc(${sql}, ${digits})`,
  log: (base, sql) => `(ln(${sql}) / ln(${base}))`,
  power: (base, exponent) => `power(${base}, ${exponent})`,
  // Inline, not in a subquery: the value may be an aggregate of the rows
  // around it.
  fromFloat: (sql) => {
    const x = `cast(${sql} as binary_double)`;
    return `(case when ${x} = 0 then 0 else round(cast(${x} as number), 14 - floor(log(10, abs(${x})))) end)`;
  },
  roundUp: (sql, digits) =>
    `(case when ${sql} = trunc(${sql}, ${digits}) then ${sql} else trunc(${sql}, ${digits}) + sign(${sql}) * power(10, -(${digits})) end)`,
  listAgg: ({ element, kind, from, where, order }) =>
    `coalesce((select json_arrayagg(${listElement(element, kind)} order by ${order.join(", ")} null on null returning clob) from ${from} where ${where}), to_clob('[]'))`,
  joinAgg: ({ element, separator, from, where, order }) =>
    `(select listagg(${element}, ${separator}) within group (order by ${order.join(", ")}) from ${from} where ${where})`,
  emptyList: (_kind) => "to_clob('[]')",
  listLength: (sql) =>
    `(select count(*) from json_table(${sql}, '$[*]' columns (v varchar2(1) path '$')))`,
  listTextLike: (sql, pattern) =>
    `exists (select 1 from json_table(${sql}, '$[*]' columns (v varchar2(4000) path '$')) e where lower(e.v) like lower(${pattern}) escape '\\')`,
  listHas: (sql, test, wanted, bind) => {
    if (wanted.length === 0) {
      return test === "any"
        ? "(1 = 0)"
        : test === "exactly"
          ? `((select count(*) from json_table(${sql}, '$[*]' columns (v varchar2(1) path '$'))) = 0)`
          : "(1 = 1)";
    }
    const values = wanted.map((item) => bind(item)).join(", ");
    const any = `exists (select 1 from json_table(${sql}, '$[*]' columns (v varchar2(4000) path '$')) e where e.v in (${values}))`;
    const all = `not exists (select 1 from (${wanted.map((item) => `select ${bind(item)} as v from dual`).join(" union all ")}) w where not exists (select 1 from json_table(${sql}, '$[*]' columns (v varchar2(4000) path '$')) e where ${binary("e.v")} = ${binary("w.v")}))`;
    switch (test) {
      case "any":
        return any;
      case "all":
        return all;
      case "none":
        return `(not ${any})`;
      case "exactly":
        return `(${all} and not exists (select 1 from json_table(${sql}, '$[*]' columns (v varchar2(4000) path '$')) e where e.v is null or ${binary("e.v")} not in (${values})))`;
    }
  },
  listSortText: (sql) => `lower(${sql})`,
  // Each item after the separator, then the first separator cut: an empty
  // text, which Oracle cannot hold, still takes its place.
  listJoin: (list, alias, text, separator) =>
    `(select substr(listagg(${separator} || ${text}) within group (order by ${alias}.i), nvl(length(${separator}), 0) + 1) from ${openItems(list, alias)} where ${text} is not null or ${alias}.j = '""')`,
  listInstant: (sql) =>
    `cast(from_tz(to_timestamp(replace(substr(${sql}, 1, length(${sql}) - 6), 'T', ' '), 'YYYY-MM-DD HH24:MI:SS.FF6'), '+00:00') as timestamp(6))`,
  listUnique: (list, _kind) =>
    arrayOf(
      "u",
      "u.i",
      `(select min(t.i) as i, t.j from ${openItems(list, "t")} group by t.j) u`,
    ),
  listCompact: (list, _kind) =>
    arrayOf("u", "u.i", `${openItems(list, "u")} where u.v is not null`),
  listSum: (list) =>
    `(select sum(to_number(u.v)) from ${openItems(list, "u")})`,
  // The list is computed first: JSON_TABLE reads no subquery that refers
  // to the row beside it.
  listItemsJoin: (list, alias) =>
    `cross apply (select ${list} as l from dual) ${alias}l cross apply ${openItems(`${alias}l.l`, alias)}`,
  listValue,
  listFrom: openItems,
  listOne: (sql, kind) =>
    `json_array(${listElement(sql, kind)} null on null returning clob)`,
  jsonObject: (entries) =>
    `json_object(${entries.map(([key, sql]) => `'${key}' value ${sql}`).join(", ")} absent on null returning clob)`,
  // Pieces between each delimiter, by their places: an empty delimiter
  // keeps the text whole.
  textSplit: (text, delimiter) =>
    `(case when ${text} is null then null when ${delimiter} is null then json_array(${text} returning clob) else (select json_arrayagg((case when p.b > p.a then ${jsonString("substr(p.x, p.a, p.b - p.a)")} else '""' end) format json order by p.k null on null returning clob) from (select t.x, level as k, case when level = 1 then 1 else instr(t.x, t.d, 1, level - 1) + length(t.d) end as a, case when instr(t.x, t.d, 1, level) = 0 then length(t.x) + 1 else instr(t.x, t.d, 1, level) end as b from (select ${text} as x, ${delimiter} as d from dual) t connect by level <= (length(t.x) - nvl(length(replace(t.x, t.d)), 0)) / length(t.d) + 1) p) end)`,
  listSort: (list, kind, descending) => {
    const key = kind === "text" ? binary("u.v") : listValue("u.v", kind);
    return arrayOf(
      "u",
      `(case when u.v is null then 1 else 0 end), ${key} ${descending ? "desc" : "asc"}, u.i`,
      openItems(list, "u"),
    );
  },
  listSlice: (list, _kind, from, to) =>
    arrayOf(
      "u",
      "u.i",
      `${openItems(list, "u")} where u.i >= ${from} and u.i <= ${to}`,
    ),
  listConcat: (lists) =>
    arrayOf(
      "u",
      "u.g, u.i",
      `(${lists.map((list, index) => `select ${String(index)} as g, t.i, t.j from ${openItems(list, "t")}`).join(" union all ")}) u`,
    ),
  boundRow: (values, alias) =>
    `(select ${values.map((value) => `${value.sql} as ${value.name}`).join(", ")} from dual) ${alias}`,
  listAggregate: (list, fn, kind) =>
    fn === "counta"
      ? `(select count(*) from ${openItems(list, "u")} where u.v is not null)`
      : `(select ${fn}(${listValue("u.v", fn === "min" || fn === "max" ? kind : "number")}) from ${openItems(list, "u")})`,
  encodeUrl,
  hashHex,
  textFrom: (sql, start) => `substr(${sql}, ${start})`,
  // No LEFT or RIGHT; SUBSTR of nothing is NULL, as empty text is.
  textLeft: (sql, count) => `substr(${sql}, 1, ${count})`,
  textRight: (sql, count) =>
    `(case when ${count} > 0 then substr(${sql}, greatest(length(${sql}) - ${count} + 1, 1)) end)`,
  textSlice: (sql, start, length) => `substr(${sql}, ${start}, ${length})`,
  // Oracle's expressions have no lookahead and no `(?:…)`, which the
  // portable subset needs, and its `$` also matches before a final newline.
  regexMatch: () => unavailable("REGEX_MATCH"),
  regexExtract: () => unavailable("REGEX_EXTRACT"),
  regexReplace: () => unavailable("REGEX_REPLACE"),
  // A JSON path must be written in the statement: the path, already
  // checked by jsonPathText, goes in as a quoted literal.
  // A JSON path must be written in the statement: the path, already
  // checked by jsonPathText, goes in as a quoted literal. A scalar reads as
  // text, an object or a list as JSON, a JSON null as nothing.
  jsonExtract: (sql, path, _bind) => {
    const at = `'${jsonPathText(path).replace(/'/g, "''")}'`;
    const doc = `(case when ${sql} is json then ${sql} end)`;
    // A number as written (`1.50`): JSON_VALUE would read it as a NUMBER.
    // Joined to '' so JSON_OBJECT takes an object read as text, as it is.
    return `(select '' || coalesce(case when regexp_like(x.w, '^\\[-?[0-9]') then substr(x.w, 2, length(x.w) - 2) end, x.v, case when substr(x.q, 1, 1) in ('{', '[') then x.q end) from (select json_value(${doc}, ${at} returning varchar2(4000)) as v, json_query(${doc}, ${at} returning varchar2(4000) with wrapper) as w, json_query(${doc}, ${at} returning varchar2(4000)) as q from dual) x)`;
  },
  exactTextKey: binary,
  // An error with no message is still one: its message carries a mark
  // first, since Oracle's empty text is NULL.
  errorMessage: (sql) => (sql === undefined ? "'!'" : `('!' || ${sql})`),
  errorJson: (sql) =>
    `(case when ${sql} is null then null when length(${sql}) = 1 then '""' else ${jsonString(`substr(${sql}, 2)`)} end) format json`,
  unavailable,
};
