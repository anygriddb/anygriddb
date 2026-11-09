/**
 * SQL Server's dialect (ADR 0005). T-SQL differs most from PostgreSQL:
 * conditions are not values (a boolean is a BIT compared to 1), zones
 * have Windows names, pages use OFFSET … FETCH, lists are JSON built by
 * STRING_AGG and read by OPENJSON, and a result row comes back as one
 * FOR JSON object. Identifiers keep their double quotes: the driver runs
 * with QUOTED_IDENTIFIER on. Text compares by code point (BIN2), its
 * trailing spaces counted; decimals are typed to 38 digits, which the
 * compiler follows (`digits.ts`, ADR 0027).
 */
import { AppError } from "../errors";
import { isTimeZone } from "../field-config";
import type { ScalarKind } from "./expressions";
import type { Bind, JsonKind, SqlDialect, TimeUnit } from "./dialect";
import { jsonPathText } from "./json-path";
import { exactMedian } from "./median";
import { WINDOWS_ZONES } from "./windows-zones";

/** Compares by code point, case and accents apart. */
const BIN = "Latin1_General_100_BIN2";

/** Text as Unicode, compared by code point. */
function exact(sql: string): string {
  return `cast(${sql} as nvarchar(max)) collate ${BIN}`;
}

const unavailable = (what: string): never => {
  throw new AppError("function_unavailable", what);
};

/** Zones IANA renamed since the CLDR list was made. */
const RENAMED: Readonly<Record<string, string>> = {
  "Europe/Kyiv": "Europe/Kiev",
  "America/Ciudad_Juarez": "America/Ojinaga",
  "Pacific/Kanton": "Pacific/Enderbury",
};

/** The Windows name of an IANA zone, which AT TIME ZONE reads. */
export function windowsZone(iana: string): string {
  if (iana === "UTC" || iana === "Etc/UTC") return "UTC";
  const name = WINDOWS_ZONES[iana] ?? WINDOWS_ZONES[RENAMED[iana] ?? ""];
  if (!name || !isTimeZone(iana)) return unavailable(`time zone ${iana}`);
  return name;
}

function zoneLiteral(iana: string): string {
  return `'${windowsZone(iana)}'`;
}

/** `decimal(14,2)` reads as `decimal`. */
function typeName(type: string): string {
  return type.toLowerCase().replace(/\(.*$/, "").trim();
}

/** A value as JSON text: a quoted, escaped string. */
function jsonString(sql: string): string {
  return `'"' + string_escape(${sql}, 'json') + '"'`;
}

/** Text without its trailing zeros: zeros become spaces, which rtrim drops. */
function trimZeros(sql: string): string {
  return `replace(rtrim(replace(${sql}, '0', ' ')), ' ', '0')`;
}

/** An instant (datetime2 in UTC) as PostgreSQL writes it: `…T09:30:00.25+00:00`. */
function instantText(sql: string): string {
  const fraction = `right('0000000' + cast(datepart(nanosecond, ${sql}) / 100 as varchar(7)), 7)`;
  return `(case when ${sql} is null then null else convert(char(19), ${sql}, 126) + case when datepart(nanosecond, ${sql}) = 0 then '' else '.' + ${trimZeros(fraction)} end + '+00:00' end)`;
}

/** The instant `sql` (UTC) as the wall clock of the zone `tz`. */
function local(sql: string, tz: string): string {
  return `cast((${sql} at time zone 'UTC') at time zone ${tz} as datetime2(7))`;
}

/** A number as its shortest exact text: `12.50` reads `12.5`, `3.00` reads `3`. */
function numberText(sql: string): string {
  const text = `cast(${sql} as varchar(64))`;
  // Trailing zeros go, then a trailing point, the same way.
  return `(case when charindex('.', ${text}) = 0 then ${text} else replace(rtrim(replace(${trimZeros(text)}, '.', ' ')), ' ', '.') end)`;
}

function json(sql: string, kind: JsonKind): string {
  switch (kind) {
    case "json":
      return `json_query(${sql})`;
    case "boolean":
      return `(case when ${sql} = 1 then cast(1 as bit) when ${sql} = 0 then cast(0 as bit) end)`;
    case "datetime":
      return instantText(sql);
    case "date":
      return `convert(char(10), ${sql}, 23)`;
    default:
      return sql;
  }
}

/** The placeholders of a list, one by one. */
function items(list: string): string[] {
  return list === "null" ? [] : list.split(", ");
}

/**
 * A list's values as a FROM item `alias(i, v, t)`: place, value as text,
 * and OPENJSON's type (0 null, 1 text, 3 boolean).
 */
function openItems(list: string, alias: string): string {
  return `(select cast([key] as int) as i, [value] as v, [type] as t from openjson(${list})) ${alias}`;
}

/** A list's value (text) back as the kind it was. */
function listValue(sql: string, kind: ScalarKind): string {
  switch (kind) {
    case "number":
      return `try_convert(decimal(38,18), ${sql})`;
    case "date":
      return `try_convert(date, ${sql})`;
    case "datetime":
      return `cast(left(${sql}, len(${sql}) - 6) as datetime2(7))`;
    case "boolean":
      return `(case when ${sql} = 'true' then cast(1 as bit) when ${sql} = 'false' then cast(0 as bit) end)`;
    default:
      return sql;
  }
}

/** A list's value as the JSON it was: text quoted again, blanks null. */
function itemJson(alias: string): string {
  return `(case ${alias}.t when 0 then 'null' when 1 then ${jsonString(`${alias}.v`)} else ${alias}.v end)`;
}

/** The digits 0–9 as a table, for counting places by cross joins. */
const DIGITS = "(values (0),(1),(2),(3),(4),(5),(6),(7),(8),(9))";

/**
 * A text character by character, each written by `piece`, joined in
 * order: `u.c` is the character and `u.u` its UTF-16 code unit, `pair`
 * the code point of a surrogate pair, `w.x` the text and `p.n` the place.
 * Places run to 10^`depth`; a longer text is blank. No regular
 * expressions or UTF-8 collations: SQL Server 2017 has neither.
 */
function perCharacter(
  sql: string,
  depth: number,
  piece: (pair: string) => string,
): string {
  // T-SQL aggregates no expression that mixes an outer column with its
  // own: the text comes into the inner query through VALUES.
  const tables = Array.from(
    { length: depth },
    (_, index) => `${DIGITS} d${String(index)}(d)`,
  ).join(" cross join ");
  const places = `(select top (len(w.x + N'.') - 1) row_number() over (order by (select null)) as n from ${tables})`;
  const pair = `(65536 + (u.u - 55296) * 1024 + (unicode(substring(w.x, p.n + 1, 1)) - 56320))`;
  const limit = `1${"0".repeat(depth)}`;
  return `(select case when s.x is null or len(s.x + N'.') - 1 > ${limit} then null else coalesce((select string_agg(cast(${piece(pair)} as nvarchar(max)), '') within group (order by p.n) from (values (s.x)) w(x) cross apply ${places} p cross apply (values (substring(w.x, p.n, 1), unicode(substring(w.x, p.n, 1)))) u(c, u)), '') end from (values (cast(${sql} as nvarchar(max)))) s(x))`;
}

/** A character's UTF-8 bytes, each written by `byte` (a number 0–255). */
function utf8Bytes(pair: string, byte: (sql: string) => string): string {
  return `when u.u between 55296 and 56319 then ${byte(`240 + ${pair} / 262144`)} + ${byte(`128 + (${pair} / 4096) % 64`)} + ${byte(`128 + (${pair} / 64) % 64`)} + ${byte(`128 + ${pair} % 64`)} when u.u between 56320 and 57343 then '' when u.u < 128 then ${byte("u.u")} when u.u < 2048 then ${byte("192 + u.u / 64")} + ${byte("128 + u.u % 64")} else ${byte("224 + u.u / 4096")} + ${byte("128 + (u.u / 64) % 64")} + ${byte("128 + u.u % 64")}`;
}

/** One byte as two hex digits. */
function hexByte(byte: string): string {
  return `convert(char(2), cast(${byte} as binary(1)), 2)`;
}

/** ENCODE_URL_COMPONENT: unreserved characters kept, the rest %-encoded. */
function encodeUrl(sql: string): string {
  return perCharacter(
    sql,
    4,
    (pair) =>
      `(case when u.c collate ${BIN} like '[A-Za-z0-9]' or u.c in (N'_', N'.', N'~', N'-') then u.c ${utf8Bytes(pair, (byte) => `'%' + ${hexByte(byte)}`)} end)`,
  );
}

const HASHES = {
  md5: { name: "MD5", length: 32 },
  sha256: { name: "SHA2_256", length: 64 },
  sha512: { name: "SHA2_512", length: 128 },
} as const;

/** A text's UTF-8 bytes hashed, as lower-case hex: up to 100,000 characters. */
function hashHex(sql: string, algorithm: keyof typeof HASHES): string {
  const { name, length } = HASHES[algorithm];
  const hex = perCharacter(
    sql,
    5,
    (pair) => `(case ${utf8Bytes(pair, hexByte)} end)`,
  );
  return `(select lower(convert(varchar(${String(length)}), hashbytes('${name}', convert(varbinary(max), cast(h.x as varchar(max)), 2)), 2)) from (values (${hex})) h(x))`;
}

/** One value of a list as JSON text: numbers canonical, as PostgreSQL's. */
function listElement(sql: string, kind: ScalarKind): string {
  switch (kind) {
    case "boolean":
      return `(case when ${sql} = 1 then 'true' when ${sql} = 0 then 'false' end)`;
    case "number":
      return jsonString(numberText(sql));
    case "date":
      return jsonString(`convert(char(10), ${sql}, 23)`);
    case "datetime":
      return jsonString(instantText(sql));
    default:
      return jsonString(sql);
  }
}

const D = "[0-9]";
const DATE = `${D}${D}${D}${D}-${D}${D}-${D}${D}`;
const CLOCK = `${DATE}[T ]${D}${D}:${D}${D}`;

/**
 * Text read as an instant by AnyGridDB's ISO 8601 grammar (ADR 0005),
 * without regular expressions: LIKE finds how long the date and time are
 * (h.n), the rest must be a zone, and TRY_CONVERT checks the day exists.
 */
function isoInstant(text: string, tz: string): string {
  const v = "p.v";
  const fraction = `patindex('%[^0-9]%', substring(${v}, 21, 7) + 'x') - 1`;
  const head = `(case when ${v} like '${CLOCK}:${D}${D}.${D}%' then (case when ${fraction} <= 6 then 20 + ${fraction} else -1 end) when ${v} like '${CLOCK}:${D}${D}%' then 19 when ${v} like '${CLOCK}%' then 16 when ${v} like '${DATE}%' then 10 else -1 end)`;
  const clock = `(case when h.n >= 16 then substring(${v}, 12, 5) + (case when h.n >= 19 then substring(${v}, 17, 3) else ':00' end) + (case when h.n > 20 then substring(${v}, 20, h.n - 19) else '' end) else '00:00:00' end)`;
  const local = `try_convert(datetime2(7), left(${v}, 10) + ' ' + ${clock}, 121)`;
  const minutes = `(case when len(z.z) = 5 then try_convert(int, substring(z.z, 4, 2)) when len(z.z) = 6 then try_convert(int, substring(z.z, 5, 2)) else 0 end)`;
  const hours = `try_convert(int, substring(z.z, 2, 2))`;
  const offset = `((case when left(z.z, 1) = '-' then -1 else 1 end) * (${hours} * 60 + ${minutes}))`;
  const zoned = `(z.z like '[+-]${D}${D}' or z.z like '[+-]${D}${D}${D}${D}' or z.z like '[+-]${D}${D}:${D}${D}')`;
  return `(select case when h.n < 0 or c.t is null then null when datalength(z.z) = 0 then cast((c.t at time zone ${tz}) at time zone 'UTC' as datetime2(7)) when z.z = 'Z' then c.t when ${zoned} and ${hours} <= 23 and ${minutes} <= 59 then dateadd(minute, -${offset}, c.t) end from (values (trim(${text}) collate ${BIN})) p(v) cross apply (values (${head})) h(n) cross apply (values (ltrim(substring(${v}, h.n + 1, 4000)))) z(z) cross apply (values (${local})) c(t))`;
}

/** .NET format strings of AnyGridDB's date tokens, in English. */
const FORMAT_TOKENS: Array<[string, string]> = [
  ["YYYY", "yyyy"],
  ["YY", "yy"],
  ["MMMM", "MMMM"],
  ["MMM", "MMM"],
  ["MM", "MM"],
  ["M", "%M"],
  ["DD", "dd"],
  ["D", "%d"],
  ["dddd", "dddd"],
  ["ddd", "ddd"],
  ["HH", "HH"],
  ["H", "%H"],
  ["hh", "hh"],
  ["h", "%h"],
  ["mm", "mm"],
  ["ss", "ss"],
  ["A", "tt"],
  ["a", "tt"],
];

/** A wall-clock timestamp formatted by a `YYYY-MM-DD`-style pattern. */
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
    const formatted = `format(${sql}, '${format}', 'en-US')`;
    parts.push(token === "a" ? `lower(${formatted})` : formatted);
    index += token.length;
  }
  if (literal) parts.push(bind(literal));
  return `(case when ${sql} is null then null else concat(${parts.join(", ")}, '') end)`;
}

/** Whole months from `start` to `end`, the day and time of each counted. */
function monthsBetween(end: string, start: string): string {
  const offset = (sql: string) =>
    `datediff_big(microsecond, datefromparts(year(${sql}), month(${sql}), 1), ${sql})`;
  return `(select case when m.e >= m.s then n.d - (case when ${offset("m.e")} < ${offset("m.s")} then 1 else 0 end) else n.d + (case when ${offset("m.e")} > ${offset("m.s")} then 1 else 0 end) end from (values (${end}, ${start})) m(e, s) cross apply (values (datediff(month, m.s, m.e))) n(d))`;
}

/** Whether two timestamps fall in the same unit; weeks start on Monday. */
function sameUnit(a: string, b: string, unit: TimeUnit): string {
  return unit === "week"
    ? `(datediff_big(week, dateadd(day, -1, ${a}), dateadd(day, -1, ${b})) = 0)`
    : `(datediff_big(${unit}, ${a}, ${b}) = 0)`;
}

export const SQLSERVER: SqlDialect = {
  name: "sqlserver",
  boolLiteral: (value) => `cast(${value ? 1 : 0} as bit)`,
  cond: (sql) => `(${sql} = 1)`,
  boolValue: (condition) =>
    `(case when ${condition} then cast(1 as bit) when not (${condition}) then cast(0 as bit) end)`,
  truth: (condition) => `((case when ${condition} then 1 else 0 end) = 1)`,
  bitOf: (sql) => `cast(${sql} as bit)`,
  zone: windowsZone,
  nullOf: (kind) =>
    kind === "boolean"
      ? "cast(null as bit)"
      : kind === "number"
        ? "cast(null as decimal(1,0))"
        : kind === "date"
          ? "cast(null as date)"
          : kind === "datetime"
            ? "cast(null as datetime2(7))"
            : "cast(null as nvarchar(max))",
  numberParam: (placeholder) => `cast(${placeholder} as decimal(38,18))`,
  textParam: (placeholder) => placeholder,
  intParam: (placeholder) => `cast(${placeholder} as int)`,
  count: (sql) => sql,
  numberText,
  dateText: (sql) => `convert(char(10), ${sql}, 23)`,
  localDatetimeText: (sql, tz) => `convert(char(16), ${local(sql, tz)}, 120)`,
  localDate: (sql, tz) => `cast(${local(sql, tz)} as date)`,
  today: (tz) => `cast(${local("sysutcdatetime()", tz)} as date)`,
  addDays: (date, days) => `dateadd(day, ${days}, ${date})`,
  addPeriod: (date, amount, unit) =>
    `dateadd(${unit}, ${String(amount)}, ${date})`,
  // Monday, whatever DATEFIRST the session has.
  startOf: (date, unit) =>
    unit === "week"
      ? `dateadd(day, -((datepart(weekday, ${date}) + @@datefirst - 2) % 7), ${date})`
      : unit === "month"
        ? `datefromparts(year(${date}), month(${date}), 1)`
        : `datefromparts(year(${date}), 1, 1)`,
  daysBetween: (end, start) => `datediff(day, ${start}, ${end})`,
  secondsBetween: (end, start) =>
    `(datediff_big(microsecond, ${start}, ${end}) / 1000000.0)`,
  // Filters follow the source's collation (ADR 0005).
  like: (sql, pattern) => `${sql} like ${pattern} escape '\\'`,
  textList: (list, bind) =>
    list.length === 0 ? "null" : list.map((item) => bind(item)).join(", "),
  inTexts: (sql, list) => `${sql} in (${list})`,
  orderTerm: (sql, direction) =>
    `(case when ${sql} is null then 1 else 0 end), ${sql} ${direction}`,
  optionPosition: (sql, list) =>
    `(case ${sql} ${items(list)
      .map((item, index) => `when ${item} then ${String(index + 1)}`)
      .join(" ")} end)`,
  sortText: (sql) => sql,
  countWhere: (condition) => `sum(case when ${condition} then 1 else 0 end)`,
  json,
  row: (entries) =>
    `(select ${entries.map(([name, sql]) => `${sql} as "${name}"`).join(", ")} for json path, without_array_wrapper, include_null_values) as "ag_row"`,
  groupKey: json,
  emptyLinks: () => "'[]'",
  // T-SQL aggregates no expression holding a subquery (error 130), and a
  // composite key's id or a computed label is one: they are computed in a
  // derived table first, and only its columns are aggregated.
  linksAgg: ({ id, label, from, where, order }) =>
    `coalesce((select '[' + string_agg(cast('{"id":' + ${jsonString('l."i"')} + ',"label":' + ${jsonString('l."l"')} + '}' as nvarchar(max)), ',') within group (order by ${order.map((_, index) => `l."o${String(index)}"`).join(", ")}) + ']' from (select ${id} as "i", ${label} as "l"${order.map((sql, index) => `, ${sql} as "o${String(index)}"`).join("")} from ${from} where ${where}) l), '[]')`,
  linksLength: (sql) => `(select count(*) from openjson(${sql}))`,
  firstLinkLabel: (sql) => `lower(json_value(${sql}, '$[0].label'))`,
  linksLabelLike: (sql, pattern) =>
    `exists (select 1 from openjson(${sql}) with (label nvarchar(max) '$.label') e where e.label like ${pattern} escape '\\')`,
  linksIdIn: (sql, list) =>
    `exists (select 1 from openjson(${sql}) with (id nvarchar(1000) '$.id') e where e.id in (${list}))`,
  readColumn: (ref, fieldType, physical) => {
    const type = typeName(physical.type);
    if (type === "float" || type === "real")
      return `cast(${ref} as decimal(38,10))`;
    if (fieldType !== "datetime") return ref;
    if (type === "datetimeoffset") {
      return `cast(switchoffset(${ref}, '+00:00') as datetime2(7))`;
    }
    // A datetime without a zone is in the source's.
    if (physical.zone === "UTC") return `cast(${ref} as datetime2(7))`;
    return `cast((${ref} at time zone ${zoneLiteral(physical.zone)}) at time zone 'UTC' as datetime2(7))`;
  },
  keyId: (columns) =>
    columns.length === 1
      ? `cast(${columns[0] ?? ""} as nvarchar(1000))`
      : `(select ${columns.map((column, index) => `${column} as "k${String(index)}"`).join(", ")} for json path, without_array_wrapper, include_null_values)`,
  contentId: (_alias, columns) =>
    columns.length === 0
      ? unavailable("contentId")
      : `lower(convert(char(32), hashbytes('MD5', (select ${columns.join(", ")} for json path, without_array_wrapper)), 2))`,
  keyText: (sql) => `cast(${sql} as nvarchar(1000))`,
  // Whole numbers the engine checked, written out.
  limitOffset: (limit, offset) => {
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) {
      throw new AppError("invalid_limit");
    }
    return ` offset ${String(offset)} rows fetch next ${String(limit)} rows only`;
  },
  groupCounts: ({ keys, source, limit }) => {
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
    const row = [...names, `"depth"`, `"count"`]
      .map((name) => `g2.${name} as ${name}`)
      .join(", ");
    return `select top (${String(Math.trunc(limit))}) (select ${row} for json path, without_array_wrapper, include_null_values) as "ag_row" from (select ${names.join(", ")}, ${depth} as "depth", count(*) as "count" from (${source}) g group by grouping sets (${sets.join(", ")})) g2`;
  },
  // The aggregate is computed in a derived table and made JSON outside:
  // FOR JSON's subquery would count its own single row.
  groupAggregates: ({ keys, source, value, kind, limit }) => {
    const names = Array.from(
      { length: keys },
      (_, index) => `"k${String(index)}"`,
    );
    const row = [
      ...names.map((name) => `g2.${name} as ${name}`),
      `${json(`g2."a0"`, kind)} as "a0"`,
    ].join(", ");
    return `select top (${String(Math.trunc(limit))}) (select ${row} for json path, without_array_wrapper, include_null_values) as "ag_row" from (select ${names.join(", ")}, ${value} as "a0" from (${source}) q group by ${names.join(", ")}) g2 order by ${names.map((name) => `g2.${name}`).join(", ")}`;
  },
  median: exactMedian,
  stddev: (sql) => `stdev(${sql})`,
  variance: (sql) => `var(${sql})`,
  stddevPop: (sql) => `stdevp(${sql})`,
  variancePop: (sql) => `varp(${sql})`,
  exactText: (sql) => `cast(${sql} as varchar(64))`,
  // A literal the compiler wrote from a number: digits, a point, a sign.
  numberLiteral: (_placeholder, value) => {
    if (!/^-?\d+(\.\d+)?$/.test(value)) throw new AppError("invalid_formula");
    const [whole = "", fraction = ""] = value.replace(/^-/, "").split(".");
    const scale = Math.min(fraction.length, 38);
    const precision = Math.min(
      Math.max(whole.replace(/^0+/, "").length + scale, 1, scale),
      38,
    );
    return `cast(${value} as decimal(${String(precision)},${String(scale)}))`;
  },
  computedText: numberText,
  // The compiler divides SQL Server's decimals itself, by their types.
  divide: (a, b) => `(${a} / nullif(${b}, 0))`,
  textToNumber: (sql) =>
    `(select case when try_convert(float, p.v) is null then null when p.v like '%[eE]%' then try_convert(decimal(38,18), try_convert(float, p.v)) else try_convert(decimal(38,18), p.v) end from (values (trim(${sql}))) p(v))`,
  textToInstant: isoInstant,
  // Digits where the shape has them, then TRY_CONVERT, which refuses a day
  // that does not exist. Cheaper than isoInstant, whose named values SQL
  // Server copies into every use.
  wallClockInstant: (sql, tz, shape) => {
    const pattern =
      shape === "date"
        ? DATE
        : shape === "minute"
          ? `${DATE} ${D}${D}:${D}${D}`
          : `${DATE} ${D}${D}:${D}${D}:${D}${D}`;
    const local = `try_convert(datetime2(7), ${sql}, 120)`;
    return `(case when ${sql} collate ${BIN} like '${pattern}' then cast((${local} at time zone ${tz}) at time zone 'UTC' as datetime2(7)) end)`;
  },
  dateToInstant: (sql, tz) =>
    `cast((cast(${sql} as datetime2(7)) at time zone ${tz}) at time zone 'UTC' as datetime2(7))`,
  localTimestamp: local,
  dateTimestamp: (sql) => `cast(${sql} as datetime2(7))`,
  now: () => "sysutcdatetime()",
  datePart: (part, sql) => {
    switch (part) {
      // Sunday is 0, whatever DATEFIRST the session has.
      case "dow":
        return `((datepart(weekday, ${sql}) + @@datefirst - 1) % 7)`;
      case "week":
        return `datepart(iso_week, ${sql})`;
      case "second":
        return `cast(datepart(second, ${sql}) + datepart(nanosecond, ${sql}) / 1000000000.0 as decimal(9,7))`;
      default:
        return `datepart(${part}, ${sql})`;
    }
  },
  monthsBetween,
  addUnit: (sql, amount, unit) => `dateadd(${unit}, ${amount}, ${sql})`,
  sameUnit,
  formatTimestamp,
  concatAll: (parts) => `concat(${parts.join(", ")}, '')`,
  trim: (sql) => `trim(${sql})`,
  locate: (needle, haystack, start, foldCase) => {
    const fold = (sql: string) => exact(foldCase ? `lower(${sql})` : sql);
    return `(case when ${needle} is null or ${haystack} is null then null when datalength(${needle}) = 0 then ${start} else charindex(${fold(needle)}, ${fold(haystack)}, ${start}) end)`;
  },
  // PostgreSQL's OVERLAY: past the end, the text is appended (STUFF would
  // return null).
  overlay: (text, insert, start, length) =>
    `(case when ${text} is null then null else concat(left(${text}, ${start} - 1), ${insert}, substring(${text}, ${start} + ${length}, 2147483647)) end)`,
  // By code point, trailing spaces counted: T-SQL pads the shorter text
  // with spaces before it compares.
  compareText: (a, symbol, b) => {
    const [x, y] = [exact(a), exact(b)];
    const length = (sql: string) => `datalength(cast(${sql} as nvarchar(max)))`;
    const same = `(${x} = ${y} and ${length(a)} = ${length(b)})`;
    switch (symbol) {
      case "=":
        return same;
      case "<>":
        return `(not ${same})`;
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const strict = symbol[0] ?? "<";
        const shorter = `${length(a)} ${strict} ${length(b)}`;
        const ordered = `(${x} ${strict} ${y} or (${x} = ${y} and ${shorter}))`;
        return symbol.length === 2 ? `(${ordered} or ${same})` : ordered;
      }
      default:
        throw new AppError("invalid_formula");
    }
  },
  // Within int's range already (`clamp`): no rounding overflows there.
  toInt: (sql) => `cast(round(cast(${sql} as decimal(38,20)), 0) as int)`,
  clamp: (sql, low, high) => {
    const value = `coalesce(${sql}, 0)`;
    return `(case when ${value} < ${String(low)} then ${String(low)} when ${value} > ${String(high)} then ${String(high)} else ${value} end)`;
  },
  mod: (a, b) => `(${a} % nullif(${b}, 0))`,
  ceil: (sql) => `ceiling(${sql})`,
  ln: (sql) => `log(${sql})`,
  // Read back into decimal(38,18), which holds 20 digits before the point.
  expCeiling: 46,
  textLength: (sql) => `(len(${sql} + N'.') - 1)`,
  textFilled: (sql) => `(datalength(${sql}) > 0)`,
  repeat: (sql, count) => `replicate(cast(${sql} as nvarchar(max)), ${count})`,
  replaceText: (text, search, replacement) =>
    `replace(${exact(text)}, ${exact(search)}, ${replacement})`,
  truncate: (sql, digits) => `round(${sql}, ${digits}, 1)`,
  log: (base, sql) => `log(${sql}, ${base})`,
  // POWER keeps a decimal base's type, and its rounding: in floating point.
  power: (base, exponent) => `power(cast(${base} as float), ${exponent})`,
  fromFloat: (sql) =>
    `(select case when f.v = 0 then 0 else round(cast(f.v as decimal(38,18)), 14 - floor(log10(abs(f.v)))) end from (values (cast(${sql} as float))) f(v))`,
  // The compiler rounds up SQL Server's decimals itself, by their types.
  roundUp: () => unavailable("ROUNDUP"),
  listAgg: ({ element, kind, from, where, order }) =>
    `coalesce((select '[' + string_agg(cast(coalesce(${listElement(element, kind)}, 'null') as nvarchar(max)), ',') within group (order by ${order.join(", ")}) + ']' from ${from} where ${where}), '[]')`,
  joinAgg: ({ element, separator, from, where, order }) =>
    `(select string_agg(cast(${element} as nvarchar(max)), ${separator}) within group (order by ${order.join(", ")}) from ${from} where ${where})`,
  emptyList: () => "'[]'",
  listLength: (sql) => `(select count(*) from openjson(${sql}))`,
  listTextLike: (sql, pattern) =>
    `exists (select 1 from openjson(${sql}) e where e.[value] like ${pattern} escape '\\')`,
  listHas: (sql, test, wanted, bind) => {
    if (wanted.length === 0) {
      return test === "any"
        ? "(1 = 0)"
        : test === "exactly"
          ? `((select count(*) from openjson(${sql})) = 0)`
          : "(1 = 1)";
    }
    const values = wanted.map((item) => `(${bind(item)})`).join(", ");
    const listed = `select w.v from (values ${values}) w(v)`;
    const any = `exists (select 1 from openjson(${sql}) e where e.[value] collate ${BIN} in (${listed}))`;
    const all = `not exists (select 1 from (values ${values}) w(v) where not exists (select 1 from openjson(${sql}) e where e.[value] collate ${BIN} = w.v))`;
    switch (test) {
      case "any":
        return any;
      case "all":
        return all;
      case "none":
        return `(not ${any})`;
      case "exactly":
        return `(${all} and not exists (select 1 from openjson(${sql}) e where e.[value] is null or e.[value] collate ${BIN} not in (${listed})))`;
    }
  },
  listSortText: (sql) => `lower(${sql})`,
  // STRING_AGG's separator must be written out: each value carries it in
  // front, and STUFF cuts the first one.
  listJoin: (list, alias, text, separator) =>
    `(select stuff(string_agg(cast(case when ${text} is null then null else concat(${separator}, ${text}) end as nvarchar(max)), '') within group (order by ${alias}.i), 1, len(${separator} + N'.') - 1, '') from ${openItems(list, alias)})`,
  listInstant: (sql) => `cast(left(${sql}, len(${sql}) - 6) as datetime2(7))`,
  listUnique: (list) =>
    `coalesce((select '[' + string_agg(cast(u.j as nvarchar(max)), ',') within group (order by u.i) + ']' from (select min(t.i) as i, min(${itemJson("t")}) as j from ${openItems(list, "t")} group by t.t, t.v collate ${BIN}) u), '[]')`,
  listCompact: (list) =>
    `coalesce((select '[' + string_agg(cast(${itemJson("u")} as nvarchar(max)), ',') within group (order by u.i) + ']' from ${openItems(list, "u")} where u.t <> 0 and datalength(u.v) > 0), '[]')`,
  listSum: (list) =>
    `(select sum(try_convert(decimal(38,18), u.v)) from ${openItems(list, "u")})`,
  listItemsJoin: (list, alias) => `cross apply ${openItems(list, alias)}`,
  listValue,
  listFrom: openItems,
  listOne: (sql, kind) =>
    `'[' + coalesce(${listElement(sql, kind)}, 'null') + ']'`,
  // The delimiter becomes U+FFFF, a noncharacter no text carries and
  // STRING_ESCAPE leaves as it is; then each one closes a value and opens
  // the next.
  textSplit: (text, delimiter) =>
    `(case when ${text} is null then null when datalength(${text}) = 0 then '[]' when datalength(coalesce(${delimiter}, '')) = 0 then '[' + ${jsonString(text)} + ']' else '["' + replace(string_escape(replace(${exact(text)}, ${exact(delimiter)}, nchar(65535)), 'json') collate ${BIN}, nchar(65535), '","') + '"]' end)`,
  listSort: (list, kind, descending) => {
    const key = kind === "text" ? `u.v collate ${BIN}` : listValue("u.v", kind);
    return `coalesce((select '[' + string_agg(cast(${itemJson("u")} as nvarchar(max)), ',') within group (order by (case when u.t = 0 then 1 else 0 end), ${key} ${descending ? "desc" : "asc"}, u.i) + ']' from ${openItems(list, "u")}), '[]')`;
  },
  // OPENJSON counts places from 0.
  listSlice: (list, _kind, from, to) =>
    `coalesce((select '[' + string_agg(cast(${itemJson("u")} as nvarchar(max)), ',') within group (order by u.i) + ']' from ${openItems(list, "u")} where u.i + 1 >= ${from} and u.i + 1 <= ${to}), '[]')`,
  listConcat: (lists) =>
    `coalesce((select '[' + string_agg(cast(${itemJson("u")} as nvarchar(max)), ',') within group (order by u.g, u.i) + ']' from (${lists.map((list, index) => `select ${String(index)} as g, cast([key] as int) as i, [value] as v, [type] as t from openjson(${list})`).join(" union all ")}) u), '[]')`,
  // FOR JSON leaves out a null value.
  jsonObject: (entries) =>
    `(select ${entries.map(([key, sql]) => `${sql} as "${key}"`).join(", ")} for json path, without_array_wrapper)`,
  boundRow: (values, alias) =>
    `(select ${values.map((value) => `${value.sql} as ${value.name}`).join(", ")}) ${alias}`,
  listAggregate: (list, fn, kind) =>
    fn === "counta"
      ? `(select count(*) from ${openItems(list, "u")} where u.t <> 0 and datalength(u.v) > 0)`
      : `(select ${fn}(${listValue("u.v", fn === "min" || fn === "max" ? kind : "number")}) from ${openItems(list, "u")})`,
  encodeUrl,
  hashHex,
  textFrom: (sql, start) => `substring(${sql}, ${start}, 2147483647)`,
  // JSON_VALUE reads scalars, JSON_QUERY objects and lists; a scalar past
  // 4,000 characters reads blank (lax mode).
  // SQL Server reads no regular expression before 2025.
  regexMatch: () => unavailable("REGEX_MATCH"),
  regexExtract: () => unavailable("REGEX_EXTRACT"),
  regexReplace: () => unavailable("REGEX_REPLACE"),
  jsonExtract: (sql, path, bind) => {
    const at = bind(jsonPathText(path));
    const json = `(case when isjson(${sql}) = 1 then ${sql} end)`;
    return `coalesce(json_value(${json}, ${at}), json_query(${json}, ${at}))`;
  },
  exactTextKey: (sql) => `${sql} collate ${BIN}`,
  unavailable,
};

export type { Bind };
