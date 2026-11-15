/**
 * SQLite dialect factory. Receives the MySQL dialect so this module never
 * imports `dialect.ts` (that file imports this one).
 */
import { AppError } from "../errors";
import { jsonPathText, type JsonStep } from "./json-path";
import { exactMedian } from "./median";
import type { SqlDialect } from "./dialect";

function unavailable(feature: string): never {
  throw new AppError("function_unavailable", feature);
}

/** SQLite spellings on top of MySQL's JSON row packing. */
export function buildSqlite(mysql: SqlDialect): SqlDialect {
  return {
    ...mysql,
    name: "sqlite",
    nullOf: (kind) => (kind === "text" ? "cast(null as text)" : "null"),
    numberParam: (placeholder) => `cast(${placeholder} as real)`,
    intParam: (placeholder) => `cast(${placeholder} as integer)`,
    numberText: (sql) => `cast(${sql} as text)`,
    dateText: (sql) => `strftime('%Y-%m-%d', ${sql})`,
    localDatetimeText: (sql) => `strftime('%Y-%m-%d %H:%M', ${sql})`,
    localDate: (sql) => `date(${sql})`,
    today: () => `date('now')`,
    addDays: (date, days) => `date(${date}, (${days}) || ' days')`,
    addPeriod: (date, amount, unit) =>
      `date(${date}, '${String(amount)} ${unit}${Math.abs(amount) === 1 ? "" : "s"}')`,
    startOf: (date, unit) =>
      unit === "week"
        ? `date(${date}, 'weekday 0', '-6 days')`
        : unit === "month"
          ? `date(${date}, 'start of month')`
          : `date(${date}, 'start of year')`,
    daysBetween: (end, start) =>
      `cast(julianday(${end}) - julianday(${start}) as integer)`,
    secondsBetween: (end, start) =>
      `(julianday(${end}) - julianday(${start})) * 86400`,
    optionPosition: () => unavailable("optionPosition"),
    json: (sql) => `json(${sql})`,
    row: (entries) =>
      `json_object(${entries
        .map(([name, sql]) => `'${name}', ${sql}`)
        .join(", ")}) as "ag_row"`,
    groupKey: (sql) => `json_array(${sql})`,
    groupKeyOrder: (sql) => `cast(${sql} as text)`,
    emptyLinks: () => "'[]'",
    linksAgg: () => unavailable("linksAgg"),
    linksLength: (sql) => `json_array_length(${sql})`,
    firstLinkLabel: (sql) => `lower(json_extract(${sql}, '$[0].label'))`,
    linksLabelLike: () => unavailable("linksLabelLike"),
    linksIdIn: () => unavailable("linksIdIn"),
    readColumn: (ref, fieldType, physical) => {
      const type = physical.type.trim().toLowerCase();
      if (
        (fieldType === "text" || fieldType === "long_text") &&
        type.startsWith("json")
      ) {
        return `cast(${ref} as text)`;
      }
      return ref;
    },
    keyId: (columns) =>
      columns.length === 1
        ? `cast(${columns[0] ?? ""} as text)`
        : `cast(json_array(${columns.join(", ")}) as text)`,
    contentId: (_alias, columns) =>
      columns.length === 0
        ? unavailable("contentId")
        : `hex(cast(json_array(${columns.join(", ")}) as blob))`,
    keyText: (sql) => `cast(${sql} as text)`,
    limitOffset: (limit, offset) => {
      if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) {
        throw new AppError("invalid_limit");
      }
      return ` limit ${String(limit)} offset ${String(offset)}`;
    },
    groupCounts: ({ keys, source, limit, starts }) => {
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
        ...(starts ? [`'start', "start"`, `'span', "span"`] : []),
      ];
      const placed = starts
        ? `, min("rn") - 1 as "start", max("rn") - min("rn") + 1 as "span"`
        : "";
      const order = starts ? ` order by "start", "depth"` : "";
      return `select json_object(${row.join(", ")}) as "ag_row" from (select ${names.join(", ")}, ${depth} as "depth", count(*) as "count"${placed} from (${source}) g group by ${names.join(", ")} ) r where "k0" is not null${order} limit ${String(Math.trunc(limit))}`;
    },
    groupAggregates: ({ keys, source, value, limit }) => {
      const names = Array.from(
        { length: keys },
        (_, index) => `"k${String(index)}"`,
      );
      const row = [
        ...names.map(
          (name, index) => `'k${String(index)}', json_extract(${name}, '$[0]')`,
        ),
        `'a0', r."a0"`,
      ];
      return `select json_object(${row.join(", ")}) as "ag_row" from (select ${names.join(", ")}, ${value} as "a0" from (${source}) q group by ${names.join(", ")}) r order by ${names.join(", ")} limit ${String(Math.trunc(limit))}`;
    },
    exactText: (sql) => `cast(${sql} as text)`,
    median: exactMedian,
    stddev: () => unavailable("stddev"),
    variance: () => unavailable("variance"),
    stddevPop: () => unavailable("stddevPop"),
    variancePop: () => unavailable("variancePop"),
    numberLiteral: (placeholder) => `cast(${placeholder} as real)`,
    computedText: (sql) => `cast(${sql} as text)`,
    divide: (a, b) => `round(${a} * 1.0 / nullif(${b}, 0), 20)`,
    textToNumber: (sql) => `cast(trim(${sql}) as real)`,
    textToInstant: (text) => text,
    wallClockInstant: (text) => text,
    dateToInstant: (sql) => sql,
    localTimestamp: (sql) => sql,
    dateTimestamp: (sql) => sql,
    now: () => `datetime('now')`,
    datePart: (part, sql) => {
      const map: Record<string, string> = {
        year: "%Y",
        month: "%m",
        day: "%d",
        hour: "%H",
        minute: "%M",
        second: "%S",
        dow: "%w",
        week: "%W",
      };
      const fmt = map[part];
      if (!fmt) return unavailable(`datePart:${part}`);
      return `cast(strftime('${fmt}', ${sql}) as integer)`;
    },
    monthsBetween: () => unavailable("monthsBetween"),
    addUnit: (sql, amount, unit) =>
      `datetime(${sql}, (${amount}) || ' ${unit}s')`,
    sameUnit: (a, b, unit) => {
      const fmt =
        unit === "year"
          ? "%Y"
          : unit === "month"
            ? "%Y-%m"
            : unit === "day"
              ? "%Y-%m-%d"
              : unit === "hour"
                ? "%Y-%m-%d %H"
                : "%Y-%m-%d %H:%M";
      return `(strftime('${fmt}', ${a}) = strftime('${fmt}', ${b}))`;
    },
    formatTimestamp: (sql, pattern, bind) =>
      `strftime(${bind(pattern)}, ${sql})`,
    concatAll: (parts) => parts.join(" || "),
    locate: (needle, haystack, start, foldCase) => {
      const left = foldCase ? `lower(${needle})` : needle;
      const right = foldCase ? `lower(${haystack})` : haystack;
      return `(case when ${needle} is null or ${haystack} is null then null else instr(substr(${right}, ${start}), ${left}) end)`;
    },
    overlay: (text, insert, start, length) =>
      `substr(${text}, 1, ${start} - 1) || ${insert} || substr(${text}, ${start} + ${length})`,
    compareText: (a, symbol, b) => `(${a} ${symbol} ${b})`,
    toInt: (sql) => `cast(${sql} as integer)`,
    clamp: (sql, low, high) =>
      `min(max(coalesce(${sql}, 0), ${String(low)}), ${String(high)})`,
    mod: (a, b) => `(${a} % nullif(${b}, 0))`,
    ceil: (sql) =>
      `(cast(${sql} as integer) + case when ${sql} > cast(${sql} as integer) then 1 else 0 end)`,
    ln: () => unavailable("ln"),
    textLength: (sql) => `length(${sql})`,
    textFilled: (sql) => `(length(${sql}) > 0)`,
    repeat: () => unavailable("repeat"),
    truncate: (sql, digits) => `round(${sql}, ${digits})`,
    log: () => unavailable("log"),
    fromFloat: (sql) => sql,
    roundUp: (sql, digits) => `round(${sql}, ${digits})`,
    listAgg: () => unavailable("listAgg"),
    joinAgg: () => unavailable("joinAgg"),
    listTextLike: () => unavailable("listTextLike"),
    listHas: () => unavailable("listHas"),
    listSortText: (sql) => `lower(cast(${sql} as text))`,
    listJoin: () => unavailable("listJoin"),
    listUnique: () => unavailable("listUnique"),
    listCompact: () => unavailable("listCompact"),
    listSum: () => unavailable("listSum"),
    listItemsJoin: () => unavailable("listItemsJoin"),
    listValue: (sql) => sql,
    listFrom: () => unavailable("listFrom"),
    listOne: (sql) => `json_array(${sql})`,
    textSplit: () => unavailable("textSplit"),
    listSort: () => unavailable("listSort"),
    listSlice: () => unavailable("listSlice"),
    listConcat: (lists) =>
      lists.length === 1 ? (lists[0] ?? "'[]'") : unavailable("listConcat"),
    boundRow: (values, alias) =>
      `(select ${values
        .map((value) => `${value.sql} as ${value.name}`)
        .join(", ")}) ${alias}`,
    listAggregate: () => unavailable("listAggregate"),
    encodeUrl: () => unavailable("encodeUrl"),
    hashHex: () => unavailable("hashHex"),
    textFrom: (sql, start) => `substr(${sql}, ${start})`,
    textLeft: (sql, count) => `substr(${sql}, 1, ${count})`,
    textRight: (sql, count) => `substr(${sql}, -(${count}))`,
    textSlice: (sql, start, length) => `substr(${sql}, ${start}, ${length})`,
    regexMatch: () => unavailable("regexMatch"),
    regexExtract: () => unavailable("regexExtract"),
    regexReplace: () => unavailable("regexReplace"),
    jsonExtract: (sql, path: readonly JsonStep[], bind) => {
      const found = `json_extract((case when json_valid(cast(${sql} as text)) then cast(${sql} as text) end), ${bind(jsonPathText(path))})`;
      return `(case when json_type(${found}) = 'null' then null else json_extract(${found}, '$') end)`;
    },
    exactTextKey: (sql) => `cast(${sql} as text)`,
    unavailable,
  };
}
