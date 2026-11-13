/**
 * The conformance suite (ADR 0005): the same formulas over the same rows
 * on PostgreSQL, MySQL, MariaDB, SQL Server, and Oracle must read the same,
 * or, where the engine computes in floating point, nearly the same (a
 * double's digits) with the field saying so; Oracle's differences all come
 * from its having no empty text, and are written out. PostgreSQL is the
 * reference; a few results are pinned outright, so the reference cannot
 * drift either.
 *
 * Everything goes the way an administrator's does: a source is declared,
 * its table exposed, each formula added as a field, and rows read.
 */
import { randomBytes } from "node:crypto";
import {
  AppError,
  buildGroupAggregates,
  describeColumns,
  type EngineCatalog,
  type FilterGroup,
} from "@anygriddb/core";
import { chartSeries } from "../data/dashboards.js";
import { importIntoTable, rowsSource } from "../data/import-commit.js";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import oracledb from "oracledb";
import pg from "pg";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { loadEngine } from "../data/engine.js";
import {
  aggregateRows,
  readPage,
  readTransaction,
  visibleFields,
} from "../data/rows.js";
import { addColumn, insertBase } from "../data/schema-ops.js";
import { createTestDatabase } from "../test-database.js";
import { insertComputed } from "../data/computed.js";
import {
  changeStatus,
  createRows,
  deleteRows,
  loadRowScope,
  replaceLinks,
  restoreRows,
  updateRows,
} from "../services/rows.js";
import { exposeTables, setTableWrites } from "./expose.js";
import { setSourcePools, SourcePools } from "./pools.js";
import { dropUnusedCopy, runSync, setTableSync } from "./sync.js";
import { readerEngine, setTableAcl } from "../data/acl.js";
import { withAudit } from "../data/audit-context.js";
import { createSource, updateSource } from "./sources.js";
import type { SourceSettings } from "./types.js";
import { listExternalTrash, settleExternalWrites } from "./writes.js";
import {
  attachExternalStatuses,
  checkSeals,
  setExternalStatus,
  signExternalRow,
} from "./statuses.js";
import { runWatch, setTableWatch } from "./watch.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";

// The client servers run on this machine, without TLS: plaintext is the
// operator's development flag, which the suite turns on.
const settings: SourceSettings = {
  allows: () => true,
  allowedHosts: [],
  allowPlaintext: true,
};

type Engine = "postgres" | "mysql" | "mariadb" | "sqlserver" | "oracle";

const ROWS = [
  "(1, 7.25, -2.5, 3, 'Hello World', 'o', '2026-02-28', '2026-01-10 09:30:00.25', true, 1)",
  "(2, null, 0, null, null, '', null, null, false, 1)",
  "(3, 1000000.10, 3, -4, 'Élan vital', 'é', '2024-02-29', '2024-12-31 23:59:59', null, 2)",
];

/** Groups the cases point to: lookups and rollups read across the link. */
const GROUPS = ["(1, 'Alpha', 1.5)", "(2, 'Beta', null)", "(3, 'Gamma', 2)"];

/** Lookups and rollups on `groups`, over its `cases` link: [label, target, fn]. */
const COMPUTED: Array<[string, string, string | undefined, FilterGroup?]> = [
  ["L_n", "n", undefined],
  ["L_s", "s", undefined],
  ["L_d", "d", undefined],
  ["L_ts", "ts", undefined],
  ["L_b", "b", undefined],
  ["L_t", "t", undefined],
  // `dup` is "x" on every case: a list that repeats itself.
  ["L_dup", "dup", undefined],
  ["R_count", "n", "count"],
  ["R_counta", "s", "counta"],
  ["R_unique", "t", "count_unique"],
  ["R_sum", "n", "sum"],
  ["R_avg", "n", "avg"],
  ["R_min", "m", "min"],
  ["R_max", "n", "max"],
  ["R_min_s", "s", "min"],
  ["R_concat", "s", "concatenate"],
  ["R_earliest", "d", "earliest"],
  ["R_latest", "ts", "latest"],
  ["R_and", "b", "and"],
  ["R_or", "b", "or"],
  ["R_sum_d", "n", "sum_distinct"],
  ["R_avg_d", "m", "avg_distinct"],
  // Sample statistics: floating point on MySQL, MariaDB, and SQL Server.
  ["R_std", "m", "std_dev"],
  ["R_var", "m", "variance"],
  // Population statistics: one value has none, spread 0.
  ["R_std_p", "m", "std_dev_pop"],
  ["R_var_p", "m", "variance_pop"],
  // Only the linked rows a condition keeps, on the cases' own fields.
  [
    "LF_s",
    "s",
    undefined,
    { conjunction: "and", conditions: [{ column: "n", op: "is_not_empty" }] },
  ],
  [
    "RF_sum",
    "n",
    "sum",
    {
      conjunction: "and",
      conditions: [{ column: "m", op: "gt", value: "0" }],
    },
  ],
  [
    "RF_count",
    "n",
    "count",
    {
      conjunction: "or",
      conditions: [
        { column: "t", op: "is", value: "O" },
        { column: "d", op: "is_before", value: "2025-01-01" },
      ],
    },
  ],
];

/** Rollups computed in floating point beyond PostgreSQL: 13 digits agree. */
const APPROXIMATE_ACROSS = ["R_std", "R_var", "R_std_p", "R_var_p"];

/** Formulas on `groups` that read the lookups and rollups. */
const GROUP_FORMULAS = [
  '{L_s} & "|"',
  "IS_BLANK({L_n})",
  "{R_sum} * 2",
  '{cases} & ""',
  'IF({R_and}, "all", "not all")',
  // Lists: joined as text, unique where first seen, blanks dropped, summed.
  'ARRAY_JOIN({L_ts}, " / ")',
  'ARRAY_JOIN(ARRAY_COMPACT({L_t}), "+")',
  'ARRAY_JOIN(ARRAY_UNIQUE({L_dup}), "+") & "|" & ARRAY_JOIN(ARRAY_UNIQUE({L_b}))',
  "{L_n} + 1",
  'SUM({L_n}, 1) & "|" & MAX({L_n}) & "|" & COUNTA({L_t}) & "|" & COUNTALL({L_t})',
  // Holidays read from a lookup: dates, and instants by the day in Paris.
  'WORKDAY_DIFF("2024-02-26", "2024-03-01", {L_d})',
  'WORKDAY("2024-02-28", 1, {L_d})',
  'WORKDAY("2024-03-04", -2, {L_d})',
  'WORKDAY_DIFF("2024-12-30", "2025-01-03", {L_ts})',
  // Lists read from a lookup: sorted with blanks last, flattened.
  'ARRAY_JOIN(ARRAY_SORT({L_t}), "+") & "|" & ARRAY_JOIN(ARRAY_SORT({L_t}, "desc"), "+") & "|" & COUNTALL(ARRAY_SORT({L_n}, "desc"))',
  'ARRAY_JOIN(ARRAY_SORT({L_b})) & "|" & ARRAY_JOIN(ARRAY_SORT({L_d}, "desc"))',
  'COUNTALL(ARRAY_FLATTEN({L_n}, {L_n}, 1)) & "|" & SUM(ARRAY_FLATTEN({L_n}, 2))',
];

/**
 * Back on `cases`, through each case's team: its team's lookups, lists of
 * lists that read flat. [label, target on teams, fn].
 */
const NESTED: Array<[string, string, string | undefined]> = [
  ["LL_n", "L_n", undefined],
  ["RR_dup", "L_dup", "array_unique"],
];

/** Filters on lookups, by the ids of the groups they keep. */
const LIST_FILTERS: Array<
  [string, { column: string; op: string; value: unknown }]
> = [
  ["contains", { column: "L_s", op: "contains", value: "world" }],
  ["has any", { column: "L_s", op: "has_any_of", value: ["Élan vital"] }],
  ["empty", { column: "L_n", op: "is_empty", value: null }],
];

/** Filters on `cases`, by the ids of the rows they keep. */
const FILTERS: Array<[string, { column: string; op: string; value: unknown }]> =
  [
    [
      "n between",
      { column: "n", op: "is_between", value: ["7.25", "1000000.1"] },
    ],
    ["n up to", { column: "n", op: "is_between", value: ["", "100"] }],
    [
      "d between",
      { column: "d", op: "is_between", value: ["2024-02-29", "2026-02-27"] },
    ],
    // By the day in Paris: 2024-12-31 23:59:59 there is already 2025-01-01.
    [
      "ts between",
      { column: "ts", op: "is_between", value: ["2025-01-01", "2026-01-10"] },
    ],
    [
      "ts one day",
      { column: "ts", op: "is_between", value: ["2024-12-31", "2024-12-31"] },
    ],
  ];

/** Formulas over columns n, m (decimals), i (integer), s, t (text), d (date), ts, b. */
const FORMULAS: string[] = [
  // Arithmetic, exact; division to 20 decimals.
  "{n} + {m}",
  "{n} - {m}",
  "{n} * {m}",
  "{n} / {m}",
  "{n} / 3",
  "1 / 3",
  "MOD({i}, 3)",
  "-{n}",
  "{i} * 2.5",
  "{n} * {i}",
  // Rounding.
  "ROUND({n} / 3, 2)",
  "ROUND({m}, 0)",
  "ROUNDDOWN({n}, 1)",
  "ROUNDUP({n}, 1)",
  "ROUNDUP({m}, 0)",
  "ROUND(1234.5678, -2)",
  "FLOOR({m})",
  "CEIL({m})",
  "ABS({m})",
  "SIGN({m})",
  "INT({n})",
  // Several values.
  "SUM({n}, {m}, {i})",
  "AVERAGE({n}, {m})",
  "AVERAGE(1, 2, 2)",
  "COUNT({n}, {m}, {i})",
  "MIN({n}, {m}, {i})",
  "MAX({n}, {m}, {i})",
  "COUNTA({s}, {t})",
  "COUNTALL({s}, {t})",
  "MIN({d}, DATE_ADD({d}, -1, 'days'))",
  // Text.
  '{s} & "!"',
  'CONCAT({s}, "-", {i})',
  "LOWER({s})",
  "UPPER({s})",
  "LEN({s})",
  'TRIM("  a b  ")',
  "LEFT({s}, 3)",
  "RIGHT({s}, 3)",
  "MID({s}, 2, 4)",
  "FIND({t}, {s})",
  'SEARCH("WORLD", {s})',
  'FIND("o", {s}, 6)',
  'SEARCH("É", {s})',
  'SUBSTITUTE({s}, "o", "0")',
  'REPLACE({s}, 1, 5, "Bye")',
  "REPT({t}, 3)",
  "T({s})",
  'VALUE("12.50")',
  'VALUE(" 1e3 ")',
  'VALUE("abc")',
  '{n} & ""',
  'ENCODE_URL_COMPONENT({s} & "/?&é~")',
  // Logic and comparisons; text compares by code point.
  'IF({n} > 5, "big", "small")',
  "AND({b}, {i} > 0)",
  "OR({b}, {i} > 0)",
  "XOR({b}, {i} > 0)",
  "NOT({b})",
  'SWITCH({t}, "o", 1, "é", 2, 0)',
  "IS_BLANK({s})",
  '{s} = "Hello World"',
  '{s} < "hello"',
  '{t} = "É"',
  "BLANK()",
  // Dates, in the reader's zone (Europe/Paris).
  "YEAR({d})",
  "MONTH({d})",
  "DAY({d})",
  "WEEKDAY({d})",
  "WEEKNUM({d})",
  "HOUR({ts})",
  "MINUTE({ts})",
  "SECOND({ts})",
  "DATESTR({ts})",
  "DATE_ADD({d}, 1, 'months')",
  "DATE_ADD({d}, 1, 'years')",
  "DATE_ADD({ts}, 90, 'minutes')",
  "DATETIME_DIFF({ts}, {d}, 'hours')",
  "DATETIME_DIFF({d}, \"2024-01-31\", 'months')",
  "DATETIME_DIFF({d}, \"2020-02-29\", 'years')",
  "DATETIME_DIFF({d}, \"2026-01-01\", 'days')",
  'DATETIME_FORMAT({ts}, "DD/MM/YYYY HH:mm")',
  'DATETIME_FORMAT({d}, "dddd D MMMM YYYY")',
  'DATETIME_FORMAT({ts}, "h:mm a")',
  "IS_SAME({ts}, \"2026-01-10T08:00:00Z\", 'day')",
  "IS_SAME({d}, \"2026-02-23\", 'week')",
  // Text read as dates, by AnyGridDB's grammar; a field's text too.
  'DATETIME_DIFF(CONCAT("2026-01-", {i} + 10), "2026-01-01", "days")',
  'DATETIME_DIFF("2026-03-01", "2026-02-28", "days") & "|" & YEAR("2026-02-30") & "|" & DATETIME_DIFF("2026-01-10T10:00:00Z", "2026-01-10 09:30", "minutes") & "|" & DATETIME_DIFF("2026-01-10T09:59:00+02:00", "2026-01-10 09:00", "minutes") & "|" & DATETIME_DIFF("2026-01-10T12:00+0530", "2026-01-10T06:30Z", "minutes")',
  "RECORD_ID()",
  // A text or a blank: MySQL once typed it binary (base64 in JSON).
  'IF({b}, "oui") & "|" & SWITCH({i}, 3, "trois")',
  // Logic, rounding to even and odd, text around a delimiter, hashes.
  'IF(TRUE(), "y", "n") & IF(FALSE(), "y", "n")',
  "IS_NOT_BLANK({s})",
  "IS_NOT_BLANK({t})",
  "EVEN({m})",
  "ODD({m})",
  "EVEN({n})",
  "ODD({n})",
  'TEXT_BEFORE({s}, " ")',
  'TEXT_AFTER({s}, " ")',
  'TEXT_BEFORE({s}, "o") & "|" & TEXT_AFTER({s}, "O") & "|" & TEXT_BEFORE({s}, "") & "|" & TEXT_AFTER({s}, "l")',
  "MID({s}, 7)",
  "SUBSTR({s}, 2, 3)",
  "MD5({s})",
  "SHA256({t})",
  "SHA512({s})",
  'MD5({t} & " ")',
  // Working days: weekends skipped, holidays written out or read; how far
  // from now; text read by a format.
  "WORKDAY({d}, 1)",
  "WORKDAY({d}, -1)",
  "WORKDAY({d}, 10)",
  "WORKDAY({d}, -7)",
  "WORKDAY({d}, 0)",
  'WORKDAY({d}, 5, "2026-03-02, 2026-03-04 2024-03-01")',
  'WORKDAY({d}, -3, "2026-02-26; 2024-02-26")',
  'WORKDAY_DIFF({d}, "2026-03-13")',
  'WORKDAY_DIFF({d}, "2026-03-13", "2026-03-02, 2026-03-04, 2026-03-07")',
  'WORKDAY_DIFF("2026-03-02", {d})',
  "TONOW({d}) - DATETIME_DIFF(TODAY(), {d})",
  'FROMNOW({ts}, "hours") - TONOW({ts}, "hours")',
  'TONOW("2100-01-01", "years") > 70',
  'DATETIME_PARSE(DATETIME_FORMAT({d}, "DD.MM.YYYY"), "DD.MM.YYYY")',
  'DATETIME_PARSE("28/02/2026 14:05", "DD/MM/YYYY HH:mm")',
  'DATETIME_PARSE("20260228235959", "YYYYMMDDHHmmss")',
  'DATETIME_PARSE("2026-07-01T10:00:00Z")',
  'DATETIME_PARSE("31/02/2026", "DD/MM/YYYY") & "|" & DATETIME_PARSE("28-02-2026", "DD/MM/YYYY") & "|" & DATETIME_PARSE("2026-02-28 7:05", "YYYY-MM-DD HH:mm")',
  // Lists: text cut at a delimiter, sorted by code point, sliced, joined.
  'ARRAY_JOIN(TEXT_SPLIT({s}, "l"), "+")',
  'COUNTALL(TEXT_SPLIT({s}, " ")) & "|" & COUNTALL(TEXT_SPLIT({t}, ","))',
  'ARRAY_JOIN(TEXT_SPLIT({s}, ""), "+")',
  'ARRAY_JOIN(TEXT_SPLIT("a\\\\b\\"c\\"d", "\\""), "+")',
  'ARRAY_JOIN(ARRAY_SORT(TEXT_SPLIT("b,a,C,é,A,,b", ",")), "") & "|" & ARRAY_JOIN(ARRAY_SORT(TEXT_SPLIT("b,a,C,é,A", ","), "desc"), "")',
  'ARRAY_JOIN(ARRAY_SLICE(TEXT_SPLIT("a,b,c,d,e", ","), 2, -2), "") & "|" & ARRAY_JOIN(ARRAY_SLICE(TEXT_SPLIT("a,b,c,d,e", ","), -2), "") & "|" & ARRAY_JOIN(ARRAY_SLICE(TEXT_SPLIT("a,b,c,d,e", ","), 4, 10), "") & "|" & COUNTALL(ARRAY_SLICE(TEXT_SPLIT("a,b,c", ","), 3, 2))',
  'ARRAY_JOIN(ARRAY_SLICE(TEXT_SPLIT({s}, " "), -1), "")',
  'ARRAY_JOIN(ARRAY_FLATTEN(TEXT_SPLIT({s}, " "), {t}, TEXT_SPLIT("x y", " ")), "+")',
  // JSON: scalars as text, objects as JSON, blank where nothing reads.
  'JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[1]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[0]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[2]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[3]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", ".a.b[1]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$[\\"é\\"]")',
  'LEFT(JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a"), 1) & RIGHT(JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b"), 1) & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.x") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[9]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[1].c") & "|" & JSON_EXTRACT("{not json", "$.a")',
  'JSON_EXTRACT(CONCAT("{\\"v\\": \\"", {t}, "\\"}"), "$.v")',
];

/**
 * Regular expressions, in the portable subset: the same on PostgreSQL,
 * MySQL, and MariaDB; SQL Server reads none before 2025.
 */
const REGEXES = [
  'REGEX_MATCH({s}, "^[A-Z]\\w+ \\w+$") & "|" & REGEX_MATCH({s}, "(?i)élan") & "|" & REGEX_MATCH({s}, "world")',
  'REGEX_EXTRACT({s}, "o\\s*\\w") & "|" & REGEX_EXTRACT({s}, "\\d+") & "|" & REGEX_EXTRACT({s}, "(?i)L+")',
  'REGEX_REPLACE({s}, "(\\w+) (\\w+)", "$2, $1 ($$) [$&]")',
  'REGEX_REPLACE({s}, "[aeiou]", "\\\\")',
  'REGEX_REPLACE({s}, " ", CONCAT("$1\\\\", {t}))',
  'REGEX_MATCH({t}, "^$")',
  'REGEX_REPLACE("a.b.c", "\\.", "-") & "|" & REGEX_REPLACE("x\\ny", "y$", "z") & "|" & REGEX_MATCH("ab\\n", "b$")',
];

/**
 * What Oracle reads apart from the others, all for one reason: it stores
 * no empty text, so case 2's `t` ('' elsewhere) is NULL there, and lists
 * built from it hold nothing where the others hold "" (docs/sources.md).
 */
const ORACLE_EMPTY_TEXT: Record<string, unknown[]> = {
  '{t} = "É"': [false, null, false],
  "SHA256({t})": [
    "65c74c15a686187bb6bbf9958f494fc6b80068034a659a9ad44991b08c58f2d2",
    null,
    "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
  ],
  'ARRAY_JOIN(ARRAY_FLATTEN(TEXT_SPLIT({s}, " "), {t}, TEXT_SPLIT("x y", " ")), "+")':
    ["Hello+World+o+x+y", "x+y", "Élan+vital+é+x+y"],
  // Alpha's cases have `t` "o" and blank: one value, not two.
  R_unique: ["1", "1", "0"],
  'ARRAY_JOIN(ARRAY_SORT({L_t}), "+") & "|" & ARRAY_JOIN(ARRAY_SORT({L_t}, "desc"), "+") & "|" & COUNTALL(ARRAY_SORT({L_n}, "desc"))':
    ["o|o|2", "é|é|1", "||0"],
};

/** An alternative: PostgreSQL takes the longest match, the others the first. */
const REGEX_AMBIGUOUS = 'REGEX_EXTRACT("ab", "a|ab")';

/**
 * Errors (ADR 0036): the value is blank, the message beside it, passed on
 * by what reads it and stopped by IS_ERROR.
 */
const ERRORS = [
  'IF({n} > 100, ERROR("trop grand"), {n})',
  'IF({n} > 100, ERROR("big: " & {s}), {n}) * 2',
  'IS_ERROR(IF({n} > 100, ERROR("x"), 1)) & "|" & IF(IS_ERROR(ERROR()), "caught", "no")',
  'SWITCH({i}, 3, ERROR("three"), -4, "minus", ERROR("other"))',
  "ERROR()",
];

/** A JSON number: MySQL reads it as a double, and says so (ADR 0027). */
const JSON_NUMBER =
  'JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[4].c")';

/** What reads across the link, compared like the formulas. */
const ACROSS = [
  ...COMPUTED.map(([label]) => label),
  ...GROUP_FORMULAS,
  ...NESTED.map(([label]) => label),
];
const ACROSS_COMPARED = [
  ...ACROSS.filter((label) => !APPROXIMATE_ACROSS.includes(label)),
  ...LIST_FILTERS.map(([name]) => `filter ${name}`),
];

/**
 * Formulas MySQL and MariaDB compute in floating point: rounded to 15
 * significant digits there, and the field says it is approximate.
 */
const APPROXIMATE = [
  "SQRT({n})",
  "POWER({n}, 2)",
  "POWER(2, {m})",
  "LN({n})",
  "EXP({m})",
  "LOG({n}, 2)",
  "LOG(1000)",
  "SQRT(2) * 2",
];

/**
 * Whether two results agree as doubles do: to 13 significant digits, once
 * a rounded value has gone through more arithmetic (`SQRT(2) * 2`).
 */
function agrees(expected: unknown, actual: unknown): boolean {
  if (typeof expected !== "string" || typeof actual !== "string") {
    return expected === actual;
  }
  const [a, b] = [Number(expected), Number(actual)];
  return Math.abs(a - b) <= 1e-13 * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * Oracle's NUMBER keeps no scale (7.50 is stored and read as 7.5): its
 * traces compare with decimals written without trailing zeros.
 */
function scaleFree(value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+\.\d*0$/.test(value)) {
    return value.replace(/\.?0+$/, "");
  }
  if (Array.isArray(value)) return value.map(scaleFree);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scaleFree(item)]),
    );
  }
  return value;
}

/** A trace as an engine reads it: Oracle's without its decimals' scale. */
function asRead(engine: Engine, value: unknown): unknown {
  return engine === "oracle" ? scaleFree(value) : value;
}

/** A read that failed, as the comparison shows it: code, then the cause. */
function failed(error: unknown): string {
  if (!(error instanceof AppError)) return `ERR ${String(error)}`;
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return `ERR ${error.code} ${cause.split("\n")[0] ?? ""}`.trim();
}

/** The field name a client column got when exposed (`id` becomes `f_id`). */
function columnOf(engine: EngineCatalog, physical: string): string {
  const column = engine.table.columns.find(
    (item) => item.physical?.name === physical,
  );
  if (!column) throw new Error(`no field for ${physical}`);
  return column.name;
}

/** Footer totals over `cases`, compared like the formulas. */
const FOOTER = [
  // Counts: T-SQL once counted 1 when FOR JSON wrapped `count(*)`.
  { column: "n", fn: "count_all" },
  { column: "n", fn: "count_filled" },
  { column: "n", fn: "median" },
  { column: "m", fn: "median" },
  { column: "n", fn: "avg" },
  { column: "n", fn: "sum" },
] as const;

/** Results pinned on the reference: AnyGridDB's semantics, written out. */
const PINNED: Record<string, unknown[]> = {
  'ENCODE_URL_COMPONENT({s} & "/?&é~")': [
    "Hello%20World%2F%3F%26%C3%A9~",
    "%2F%3F%26%C3%A9~",
    "%C3%89lan%20vital%2F%3F%26%C3%A9~",
  ],
  'DATETIME_FORMAT({ts}, "h:mm a")': ["10:30 am", null, "12:59 am"],
  'ARRAY_JOIN({L_ts}, " / ")': ["2026-01-10 10:30", "2025-01-01 00:59", null],
  'ARRAY_JOIN(ARRAY_COMPACT({L_t}), "+")': ["o", "é", null],
  'ARRAY_JOIN(ARRAY_UNIQUE({L_dup}), "+") & "|" & ARRAY_JOIN(ARRAY_UNIQUE({L_b}))':
    ["x|true, false", "x|", "|"],
  "{L_n} + 1": ["8.25", "1000001.1", null],
  'SUM({L_n}, 1) & "|" & MAX({L_n}) & "|" & COUNTA({L_t}) & "|" & COUNTALL({L_t})':
    ["8.25|7.25|1|2", "1000001.1|1000000.1|1|1", "1||0|0"],
  LL_n: [["7.25", null], ["7.25", null], ["1000000.1"]],
  RR_dup: [["x"], ["x"], ["x"]],
  footer: [3, 2, 500003.675, 0, 500003.675, 1000007.35],
  "filter n between": ["1", "3"],
  "filter n up to": ["1"],
  "filter d between": ["3"],
  "filter ts between": ["1", "3"],
  "filter ts one day": [],
  // Rollups on teams 1, 2, 3: n is 7.25 and empty, 1000000.10, nothing;
  // m is -2.5 and 0, 3, nothing. One value has no sample spread. A sum
  // of nothing is 0, as a count is.
  R_sum_d: ["7.25", "1000000.1", "0"],
  R_avg_d: ["-1.25", "3", null],
  R_std: ["1.7677669529663688", null, null],
  R_var: ["3.125", null, null],
  R_std_p: ["1.25", "0", null],
  R_var_p: ["1.5625", "0", null],
  LF_s: [["Hello World"], ["Élan vital"], []],
  RF_sum: ["0", "1000000.1", "0"],
  RF_count: ["1", "1", "0"],
  "{n} / {m}": ["-2.9", null, "333333.36666666666666666667"],
  'IF(TRUE(), "y", "n") & IF(FALSE(), "y", "n")': ["yn", "yn", "yn"],
  'TEXT_BEFORE({s}, "o") & "|" & TEXT_AFTER({s}, "O") & "|" & TEXT_BEFORE({s}, "") & "|" & TEXT_AFTER({s}, "l")':
    ["Hell|||lo World", "|||", "|||an vital"],
  "WORKDAY({d}, 1)": ["2026-03-02", null, "2024-03-01"],
  "WORKDAY({d}, -1)": ["2026-02-27", null, "2024-02-28"],
  "WORKDAY({d}, 10)": ["2026-03-13", null, "2024-03-14"],
  "WORKDAY({d}, -7)": ["2026-02-19", null, "2024-02-20"],
  "WORKDAY({d}, 0)": ["2026-02-28", null, "2024-02-29"],
  'WORKDAY({d}, 5, "2026-03-02, 2026-03-04 2024-03-01")': [
    "2026-03-10",
    null,
    "2024-03-08",
  ],
  'WORKDAY({d}, -3, "2026-02-26; 2024-02-26")': [
    "2026-02-24",
    null,
    "2024-02-23",
  ],
  'WORKDAY_DIFF({d}, "2026-03-13")': ["10", null, "532"],
  'WORKDAY_DIFF({d}, "2026-03-13", "2026-03-02, 2026-03-04, 2026-03-07")': [
    "8",
    null,
    "530",
  ],
  'WORKDAY_DIFF("2026-03-02", {d})': ["-1", null, "-523"],
  "TONOW({d}) - DATETIME_DIFF(TODAY(), {d})": ["0", null, "0"],
  'FROMNOW({ts}, "hours") - TONOW({ts}, "hours")': ["0", null, "0"],
  'TONOW("2100-01-01", "years") > 70': [true, true, true],
  'DATETIME_PARSE(DATETIME_FORMAT({d}, "DD.MM.YYYY"), "DD.MM.YYYY")': [
    "2026-02-28",
    null,
    "2024-02-29",
  ],
  'DATETIME_PARSE("31/02/2026", "DD/MM/YYYY") & "|" & DATETIME_PARSE("28-02-2026", "DD/MM/YYYY") & "|" & DATETIME_PARSE("2026-02-28 7:05", "YYYY-MM-DD HH:mm")':
    ["||", "||", "||"],
  'WORKDAY_DIFF("2024-02-26", "2024-03-01", {L_d})': ["5", "4", "5"],
  'WORKDAY("2024-02-28", 1, {L_d})': ["2024-02-29", "2024-03-01", "2024-02-29"],
  'WORKDAY("2024-03-04", -2, {L_d})': [
    "2024-02-29",
    "2024-02-28",
    "2024-02-29",
  ],
  'WORKDAY_DIFF("2024-12-30", "2025-01-03", {L_ts})': ["5", "4", "5"],
  'ARRAY_JOIN(TEXT_SPLIT({s}, "l"), "+")': ["He++o Wor+d", null, "É+an vita+"],
  'JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[1]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[0]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[2]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[3]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", ".a.b[1]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$[\\"é\\"]")':
    ["x|10|true||x|accent", "x|10|true||x|accent", "x|10|true||x|accent"],
  'LEFT(JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a"), 1) & RIGHT(JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b"), 1) & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.x") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[9]") & "|" & JSON_EXTRACT("{\\"a\\": {\\"b\\": [10, \\"x\\", true, null, {\\"c\\": 1.50}]}, \\"é\\": \\"accent\\"}", "$.a.b[1].c") & "|" & JSON_EXTRACT("{not json", "$.a")':
    ["{]||||", "{]||||", "{]||||"],
  'JSON_EXTRACT(CONCAT("{\\"v\\": \\"", {t}, "\\"}"), "$.v")': ["o", "", "é"],
  [JSON_NUMBER]: ["1.50", "1.50", "1.50"],
  [REGEXES[0] ?? ""]: [
    "true|false|false",
    "false|false|false",
    "false|true|false",
  ],
  [REGEXES[1] ?? ""]: ["o W||ll", "||", "||l"],
  [REGEXES[2] ?? ""]: [
    "World, Hello ($) [Hello World]",
    null,
    "Évital, lan ($) [lan vital]",
  ],
  [REGEXES[3] ?? ""]: ["H\\ll\\ W\\rld", null, "Él\\n v\\t\\l"],
  [REGEXES[4] ?? ""]: ["Hello$1\\oWorld", null, "Élan$1\\évital"],
  [REGEXES[5] ?? ""]: [false, true, false],
  [REGEXES[6] ?? ""]: [
    "a-b-c|x\nz|false",
    "a-b-c|x\nz|false",
    "a-b-c|x\nz|false",
  ],
  [REGEX_AMBIGUOUS]: ["ab", "ab", "ab"],
  'IF({b}, "oui") & "|" & SWITCH({i}, 3, "trois")': ["oui|trois", "|", "|"],
  [ERRORS[0] ?? ""]: ["7.25", null, null],
  [`errors ${ERRORS[0] ?? ""}`]: [null, null, "trop grand"],
  [ERRORS[1] ?? ""]: ["14.5", null, null],
  [`errors ${ERRORS[1] ?? ""}`]: [null, null, "big: Élan vital"],
  [ERRORS[2] ?? ""]: ["false|caught", "false|caught", "true|caught"],
  [`errors ${ERRORS[2] ?? ""}`]: [null, null, null],
  [ERRORS[3] ?? ""]: [null, null, "minus"],
  [`errors ${ERRORS[3] ?? ""}`]: ["three", "other", null],
  [ERRORS[4] ?? ""]: [null, null, null],
  [`errors ${ERRORS[4] ?? ""}`]: ["", "", ""],
  'COUNTALL(TEXT_SPLIT({s}, " ")) & "|" & COUNTALL(TEXT_SPLIT({t}, ","))': [
    "2|1",
    "0|0",
    "2|1",
  ],
  'ARRAY_JOIN(TEXT_SPLIT({s}, ""), "+")': ["Hello World", null, "Élan vital"],
  'ARRAY_JOIN(TEXT_SPLIT("a\\\\b\\"c\\"d", "\\""), "+")': [
    "a\\b+c+d",
    "a\\b+c+d",
    "a\\b+c+d",
  ],
  'ARRAY_JOIN(ARRAY_SORT(TEXT_SPLIT("b,a,C,é,A,,b", ",")), "") & "|" & ARRAY_JOIN(ARRAY_SORT(TEXT_SPLIT("b,a,C,é,A", ","), "desc"), "")':
    ["ACabbé|ébaCA", "ACabbé|ébaCA", "ACabbé|ébaCA"],
  'ARRAY_JOIN(ARRAY_SLICE(TEXT_SPLIT("a,b,c,d,e", ","), 2, -2), "") & "|" & ARRAY_JOIN(ARRAY_SLICE(TEXT_SPLIT("a,b,c,d,e", ","), -2), "") & "|" & ARRAY_JOIN(ARRAY_SLICE(TEXT_SPLIT("a,b,c,d,e", ","), 4, 10), "") & "|" & COUNTALL(ARRAY_SLICE(TEXT_SPLIT("a,b,c", ","), 3, 2))':
    ["bcd|de|de|0", "bcd|de|de|0", "bcd|de|de|0"],
  'ARRAY_JOIN(ARRAY_SLICE(TEXT_SPLIT({s}, " "), -1), "")': [
    "World",
    null,
    "vital",
  ],
  'ARRAY_JOIN(ARRAY_FLATTEN(TEXT_SPLIT({s}, " "), {t}, TEXT_SPLIT("x y", " ")), "+")':
    ["Hello+World+o+x+y", "+x+y", "Élan+vital+é+x+y"],
  'ARRAY_JOIN(ARRAY_SORT({L_t}), "+") & "|" & ARRAY_JOIN(ARRAY_SORT({L_t}, "desc"), "+") & "|" & COUNTALL(ARRAY_SORT({L_n}, "desc"))':
    ["+o|o+|2", "é|é|1", "||0"],
  'ARRAY_JOIN(ARRAY_SORT({L_b})) & "|" & ARRAY_JOIN(ARRAY_SORT({L_d}, "desc"))':
    ["false, true|2026-02-28", "|2024-02-29", "|"],
  'COUNTALL(ARRAY_FLATTEN({L_n}, {L_n}, 1)) & "|" & SUM(ARRAY_FLATTEN({L_n}, 2))':
    ["5|9.25", "3|1000002.1", "1|2"],
  "IS_NOT_BLANK({t})": [true, false, true],
  "EVEN({m})": ["-4", "0", "4"],
  "ODD({m})": ["-3", "1", "3"],
  "EVEN({n})": ["8", null, "1000002"],
  "ODD({n})": ["9", null, "1000001"],
  'TEXT_BEFORE({s}, " ")': ["Hello", null, "Élan"],
  'TEXT_AFTER({s}, " ")': ["World", null, "vital"],
  "MID({s}, 7)": ["World", null, "ital"],
  "SUBSTR({s}, 2, 3)": ["ell", null, "lan"],
  "MD5({s})": [
    "b10a8db164e0754105b7a99be72e3fe5",
    null,
    "603aedacf76e6182a1bbc477a79f5230",
  ],
  "SHA256({t})": [
    "65c74c15a686187bb6bbf9958f494fc6b80068034a659a9ad44991b08c58f2d2",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
  ],
  "SHA512({s})": [
    "2c74fd17edafd80e8447b0d46741ee243b7eb74dd2149a0ab1b9246fb30382f27e853d8585719e0e67cbda0daa8f51671064615d645ae27acb15bfb1447f459b",
    null,
    "61329ac470d6e733f4f750f304ca811ca35a779128db742333e8f31d8f24c7e23f01ace12e3df821c686e01fc8698acfc51885724cac161b03011e138ec8731c",
  ],
  'MD5({t} & " ")': [
    "236508fdc8586ad6ed73c3f5fb305fb6",
    "7215ee9c7d9dc229d2921a40e899ec5f",
    "644c0d68c55642032d90870be2b9f772",
  ],
  "1 / 3": [
    "0.33333333333333333333",
    "0.33333333333333333333",
    "0.33333333333333333333",
  ],
  "AVERAGE(1, 2, 2)": [
    "1.66666666666666666667",
    "1.66666666666666666667",
    "1.66666666666666666667",
  ],
  "{n} * {m}": ["-18.125", null, "3000000.3"],
  // Across the link: groups Alpha (cases 1, 2), Beta (case 3), Gamma (none).
  L_n: [["7.25", null], ["1000000.1"], []],
  L_b: [[true, false], [null], []],
  R_count: ["2", "1", "0"],
  R_avg: ["7.25", "1000000.1", null],
  R_concat: ["Hello World", "Élan vital", null],
  // A blank counts as false.
  R_and: [false, false, null],
  R_or: [true, false, null],
  '{L_s} & "|"': ["Hello World|", "Élan vital|", "|"],
  'FIND("o", {s}, 6)': ["8", null, "0"],
  'SEARCH("É", {s})': ["0", null, "1"],
  // By code point: É (U+00C9) comes after h.
  '{s} < "hello"': [true, null, false],
  '{t} = "É"': [false, false, false],
  "SECOND({ts})": ["0.25", null, "59"],
  "DATESTR({ts})": ["2026-01-10", null, "2025-01-01"],
  'DATETIME_FORMAT({d}, "dddd D MMMM YYYY")': [
    "Saturday 28 February 2026",
    null,
    "Thursday 29 February 2024",
  ],
  "DATE_ADD({ts}, 90, 'minutes')": [
    "2026-01-10T11:00:00.25+00:00",
    null,
    "2025-01-01T01:29:59+00:00",
  ],
  'DATETIME_DIFF("2026-03-01", "2026-02-28", "days") & "|" & YEAR("2026-02-30") & "|" & DATETIME_DIFF("2026-01-10T10:00:00Z", "2026-01-10 09:30", "minutes") & "|" & DATETIME_DIFF("2026-01-10T09:59:00+02:00", "2026-01-10 09:00", "minutes") & "|" & DATETIME_DIFF("2026-01-10T12:00+0530", "2026-01-10T06:30Z", "minutes")':
    ["1||90|-1|0", "1||90|-1|0", "1||90|-1|0"],
};

function mysqlServer(image: string, env: Record<string, string>) {
  return new GenericContainer(image)
    .withEnvironment(env)
    .withExposedPorts(3306)
    .withWaitStrategy(Wait.forLogMessage(/port: 3306/))
    .withStartupTimeout(180_000)
    .start();
}

const SA_PASSWORD = "Admin!Passw0rd-2026";

/** The same tables in T-SQL: N'' text, bits for booleans. */
const SQLSERVER_SETUP = [
  "create database erp",
  "go",
  "use erp",
  "create login reader with password = 'readerpass', check_policy = off",
  "create user reader for login reader",
  "create table teams (id int primary key, name nvarchar(100), weight decimal(10,3))",
  "create table cases (id int primary key, n decimal(14,2), m decimal(14,2), i int, s nvarchar(100), t nvarchar(100), d date, ts datetime2(6), b bit, g int, foreign key (g) references teams(id))",
  ...[
    `insert into teams values ${GROUPS.join(", ")}`,
    `insert into cases values ${ROWS.join(", ")}`,
  ].map((sql) =>
    sql
      .replace(/'([^']*)'/g, "N'$1'")
      .replace(/\btrue\b/g, "1")
      .replace(/\bfalse\b/g, "0"),
  ),
  "grant select on cases to reader",
  "grant select on teams to reader",
  // Written to by the writes test; the read fixtures stay as they are.
  "create table ledger (id int identity primary key, label nvarchar(20) not null unique, amount decimal(10,2), qty int, paid bit, due date, at datetime2(6), team int foreign key references teams(id), note nvarchar(5))",
  "create table pairs (a int, b nvarchar(10), v int, primary key (a, b), foreign key (a) references teams(id))",
  "insert into ledger (label, amount, qty, paid, due, at, team, note) values (N'L1', 10.50, 1, 0, '2026-01-01', '2026-01-01 08:00:00', 1, N'x')",
  "grant select, insert, update, delete on ledger to reader",
  "grant select, insert, update, delete on pairs to reader",
  // Changes made elsewhere (ADR 0031): Change Tracking on one table.
  "alter database erp set change_tracking = on (change_retention = 1 days)",
  "create table watched (id int primary key, label nvarchar(20), changed datetime2(3) not null default sysutcdatetime())",
  "alter table watched enable change_tracking",
  "insert into watched (id, label) values (1, N'a'), (2, N'b')",
  "grant select, update on watched to reader",
  "grant view change tracking on watched to reader",
  // Statuses and seals (ADR 0033): rows AnyGridDB may change, not delete.
  "create table approvals (id int primary key, label nvarchar(20), amount decimal(10,2), due date)",
  "insert into approvals values (1, N'A1', 10.50, '2026-03-01'), (2, N'A2', 20.00, null)",
  "grant select, update on approvals to reader",
  // Field and row rules (ADR 0016) where the rows live.
  "create table staff (id int primary key, name nvarchar(20), dept nvarchar(10), salary decimal(10,2))",
  "insert into staff values (1, N'Ann', N'sales', 100.00), (2, N'Bob', N'ops', 200.00), (3, N'Cy', N'sales', 300.00), (4, N'Di', N'ops', 400.00)",
  "grant select, update on staff to reader",
  // Fields AnyGridDB adds (ADR 0032): a schema kept for it.
  "go",
  "create schema ag_side",
  "go",
  "grant create table to reader",
  "grant alter, select, insert, update, delete on schema::ag_side to reader",
].join("\n");

async function sqlServer(): Promise<StartedTestContainer> {
  const server = await new GenericContainer(
    "mcr.microsoft.com/mssql/server:2022-latest",
  )
    .withEnvironment({ ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: SA_PASSWORD })
    .withExposedPorts(1433)
    .withWaitStrategy(
      Wait.forLogMessage(/SQL Server is now ready for client connections/),
    )
    .withStartupTimeout(240_000)
    .start();
  const sqlcmd = (...args: string[]) =>
    server.exec([
      "/opt/mssql-tools18/bin/sqlcmd",
      "-S",
      "localhost",
      "-U",
      "sa",
      "-P",
      SA_PASSWORD,
      "-C",
      "-b",
      ...args,
    ]);
  // The server says it is ready a moment before sa can sign in.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await sqlcmd("-Q", "select 1")).exitCode === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await server.exec([
    "bash",
    "-c",
    `cat > /tmp/setup.sql <<'SQL'\n${SQLSERVER_SETUP}\nSQL`,
  ]);
  const created = await sqlcmd("-i", "/tmp/setup.sql");
  expect(created.exitCode, created.output).toBe(0);
  return server;
}

const ORACLE_PASSWORD = "Admin_Passw0rd_2026";

/**
 * The same tables on Oracle, owned by `erp` and read by a dedicated
 * account given rights on them, as docs/sources.md asks: names quoted in
 * lower case, as the other engines spell them; NUMBER(1) for booleans;
 * the side table in the account's own schema.
 */
const ORACLE_TABLES = [
  'create table "teams" ("id" number(10) primary key, "name" varchar2(100), "weight" number(10,3))',
  'create table "cases" ("id" number(10) primary key, "n" number(14,2), "m" number(14,2), "i" number(10), "s" varchar2(100), "t" varchar2(100), "d" date, "ts" timestamp(6), "b" number(1), "g" number(10) references "teams"("id"))',
  'create table "ledger" ("id" number(10) generated by default as identity (nocache) primary key, "label" varchar2(20) not null unique, "amount" number(10,2), "qty" number(10), "paid" number(1), "due" date, "at" timestamp(6), "team" number(10) references "teams"("id"), "note" varchar2(5))',
  'create table "pairs" ("a" number(10), "b" varchar2(10), "v" number(10), primary key ("a", "b"), foreign key ("a") references "teams"("id"))',
  'create table "watched" ("id" number(10) primary key, "label" varchar2(20), "changed" timestamp(3) default sys_extract_utc(systimestamp) not null)',
  'create trigger "watched_touch" before update on "watched" for each row begin :new."changed" := sys_extract_utc(systimestamp); end;',
  'create table "approvals" ("id" number(10) primary key, "label" varchar2(20), "amount" number(10,2), "due" date)',
  'create table "staff" ("id" number(10) primary key, "name" varchar2(20), "dept" varchar2(10), "salary" number(10,2))',
];

/** Names the suite's SQL uses, quoted for the tables above. */
const ORACLE_NAMES =
  /\b(teams|cases|ledger|pairs|watched|approvals|staff|id|name|weight|label|amount|qty|paid|due|at|team|note|changed|dept|salary)\b/g;

/**
 * The suite's SQL as Oracle takes it: names quoted, dates and instants
 * typed, booleans as 0 and 1, several rows inserted one by one, one
 * statement at a time.
 */
function oracleStatements(statement: string): string[] {
  return statement
    .split(/;\s*/)
    .filter((part) => part.trim() !== "")
    .flatMap((part) => {
      const typed = part
        .replace(/'(\d{4}-\d{2}-\d{2})'/g, "date '$1'")
        .replace(
          /'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)'/g,
          "timestamp '$1'",
        )
        .replace(/\btrue\b/g, "1")
        .replace(/\bfalse\b/g, "0");
      const quoted = typed.replace(/'[^']*'|"[^"]*"|[A-Za-z_]+/g, (word) =>
        /^['"]/.test(word) ? word : word.replace(ORACLE_NAMES, '"$1"'),
      );
      const many = /^(insert into \S+(?: \([^)]*\))? values )(\(.*\))$/i.exec(
        quoted,
      );
      if (!many) return [quoted];
      const [, head = "", rows = ""] = many;
      return rows
        .split(/\),\s*\(/)
        .map((row) => `${head}(${row.replace(/^\(|\)$/g, "")})`);
    });
}

async function oracleServer(): Promise<StartedTestContainer> {
  const server = await new GenericContainer(
    "gvenzl/oracle-free:23-slim-faststart",
  )
    .withEnvironment({
      ORACLE_PASSWORD,
      APP_USER: "erp",
      APP_USER_PASSWORD: "erppass",
    })
    .withExposedPorts(1521)
    .withWaitStrategy(Wait.forLogMessage(/DATABASE IS READY TO USE/i))
    .withStartupTimeout(600_000)
    .start();
  const connectString = `localhost:${String(server.getMappedPort(1521))}/FREEPDB1`;
  const system = await oracledb.getConnection({
    user: "system",
    password: ORACLE_PASSWORD,
    connectString,
  });
  for (const statement of [
    "create user reader identified by readerpass quota unlimited on users",
    "grant create session, create table to reader",
  ]) {
    await system.execute(statement);
  }
  await system.close();
  const erp = await oracledb.getConnection({
    user: "erp",
    password: "erppass",
    connectString,
  });
  for (const statement of [
    ...ORACLE_TABLES,
    ...[
      `insert into teams values ${GROUPS.join(", ")}`,
      `insert into cases values ${ROWS.join(", ")}`,
      "insert into ledger (label, amount, qty, paid, due, at, team, note) values ('L1', 10.50, 1, 0, '2026-01-01', '2026-01-01 08:00:00', 1, 'x')",
      "insert into watched (id, label) values (1, 'a'), (2, 'b')",
      "insert into approvals values (1, 'A1', 10.50, '2026-03-01'), (2, 'A2', 20.00, null)",
      "insert into staff values (1, 'Ann', 'sales', 100.00), (2, 'Bob', 'ops', 200.00), (3, 'Cy', 'sales', 300.00), (4, 'Di', 'ops', 400.00)",
      "grant select on cases to reader",
      "grant select on teams to reader",
      "grant select, insert, update, delete on ledger to reader",
      "grant select, insert, update, delete on pairs to reader",
      "grant select, update on watched to reader",
      "grant select, update on approvals to reader",
      "grant select, update on staff to reader",
    ].flatMap(oracleStatements),
  ]) {
    await erp.execute(statement);
  }
  await erp.commit();
  await erp.close();
  return server;
}

const MYSQL_TABLES = [
  "create table teams (id int primary key, name varchar(100), weight decimal(10,3))",
  "create table cases (id int primary key, n decimal(14,2), m decimal(14,2), i int, s varchar(100), t varchar(100), d date, ts datetime(6), b tinyint(1), g int, foreign key (g) references teams(id))",
  "create table ledger (id int auto_increment primary key, label varchar(20) not null unique, amount decimal(10,2), qty int, paid tinyint(1), due date, at datetime(6), team int, note varchar(5), foreign key (team) references teams(id))",
  "create table pairs (a int, b varchar(10), v int, primary key (a, b), foreign key (a) references teams(id))",
  "create table watched (id int primary key, label varchar(20), changed datetime(3) not null default current_timestamp(3) on update current_timestamp(3))",
  "create table approvals (id int primary key, label varchar(20), amount decimal(10,2), due date)",
  "create table staff (id int primary key, name varchar(20), dept varchar(10), salary decimal(10,2))",
];

describe("conformance of formulas across engines", () => {
  const servers: StartedTestContainer[] = [];
  const results = new Map<Engine, Map<string, unknown[]>>();
  const refused = new Map<Engine, Map<string, string>>();
  const limited = new Map<Engine, Map<string, unknown>>();
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let pools: SourcePools | undefined;
  const key = randomBytes(32);
  /** What the writes test needs: each source, its schema, and the base. */
  const declared = new Map<Engine, { sourceId: string; schema: string }>();
  let actorId = "";
  let baseId = "";
  /** The PostgreSQL client database, as its own administrator reaches it. */
  let erpUrl = "";
  let oracle: StartedTestContainer | undefined;
  /** Runs SQL as another application would, with the engine's administrator. */
  const outside = async (engine: Engine, statement: string) => {
    if (engine === "postgres") {
      const other = new pg.Client({ connectionString: erpUrl });
      await other.connect();
      await other.query(statement);
      await other.end();
      return;
    }
    if (engine === "oracle") {
      const erp = await oracledb.getConnection({
        user: "erp",
        password: "erppass",
        connectString: `localhost:${String(oracle?.getMappedPort(1521))}/FREEPDB1`,
      });
      try {
        for (const part of oracleStatements(statement)) {
          await erp.execute(part, [], { autoCommit: true });
        }
      } finally {
        await erp.close();
      }
      return;
    }
    const [mysqlContainer, mariadbContainer, sqlServerContainer] = servers;
    const done =
      engine === "sqlserver"
        ? await sqlServerContainer?.exec([
            "/opt/mssql-tools18/bin/sqlcmd",
            "-S",
            "localhost",
            "-U",
            "sa",
            "-P",
            SA_PASSWORD,
            "-C",
            "-b",
            "-d",
            "erp",
            "-Q",
            statement,
          ])
        : await (engine === "mysql" ? mysqlContainer : mariadbContainer)?.exec([
            engine,
            "-uroot",
            "-prootpass",
            "erp",
            "-e",
            statement,
          ]);
    expect(done?.exitCode, done?.output).toBe(0);
  };

  beforeAll(async () => {
    const [
      mysqlContainer,
      mariadbContainer,
      sqlServerContainer,
      oracleContainer,
    ] = await Promise.all([
      mysqlServer("mysql:8.4", {
        MYSQL_ROOT_PASSWORD: "rootpass",
        MYSQL_DATABASE: "erp",
      }),
      mysqlServer("mariadb:11.4", {
        MARIADB_ROOT_PASSWORD: "rootpass",
        MARIADB_DATABASE: "erp",
      }),
      sqlServer(),
      oracleServer(),
    ]);
    oracle = oracleContainer;
    servers.push(
      mysqlContainer,
      mariadbContainer,
      sqlServerContainer,
      oracleContainer,
    );
    for (const [server, client] of [
      [mysqlContainer, "mysql"],
      [mariadbContainer, "mariadb"],
    ] as const) {
      const created = await server.exec([
        client,
        // The command line's own charset would garble É on the way in.
        "--default-character-set=utf8mb4",
        "-uroot",
        "-prootpass",
        "erp",
        "-e",
        [
          "create user 'reader'@'%' identified by 'readerpass'",
          ...MYSQL_TABLES,
          `insert into teams values ${GROUPS.join(", ")}`,
          `insert into cases values ${ROWS.join(", ")}`,
          "grant select on erp.cases to 'reader'@'%'",
          "grant select on erp.teams to 'reader'@'%'",
          "insert into ledger (label, amount, qty, paid, due, at, team, note) values ('L1', 10.50, 1, 0, '2026-01-01', '2026-01-01 08:00:00', 1, 'x')",
          "grant select, insert, update, delete on erp.ledger to 'reader'@'%'",
          "grant select, insert, update, delete on erp.pairs to 'reader'@'%'",
          "insert into watched (id, label) values (1, 'a'), (2, 'b')",
          "grant select, update on erp.watched to 'reader'@'%'",
          "insert into approvals values (1, 'A1', 10.50, '2026-03-01'), (2, 'A2', 20.00, null)",
          "grant select, update on erp.approvals to 'reader'@'%'",
          "insert into staff values (1, 'Ann', 'sales', 100.00), (2, 'Bob', 'ops', 200.00), (3, 'Cy', 'sales', 300.00), (4, 'Di', 'ops', 400.00)",
          "grant select, update on erp.staff to 'reader'@'%'",
          "create database ag_side",
          "grant create, alter, select, insert, update, delete on ag_side.* to 'reader'@'%'",
        ].join("; "),
      ]);
      expect(created.exitCode, created.output).toBe(0);
    }

    // The PostgreSQL client: a database of its own on the test server.
    const adminUrl = inject("adminUrl");
    const name = `erp_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin
      .query(`create role conformance_reader login password 'readerpass'`)
      .catch(() => undefined);
    await admin.end();
    const clientUrl = new URL(adminUrl);
    clientUrl.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: clientUrl.toString() });
    await client.connect();
    await client.query(
      "create table teams (id int primary key, name varchar(100), weight numeric(10,3))",
    );
    await client.query(
      "create table cases (id int primary key, n numeric(14,2), m numeric(14,2), i int, s varchar(100), t varchar(100), d date, ts timestamp(6), b boolean, g int references teams(id))",
    );
    await client.query(`insert into teams values ${GROUPS.join(", ")}`);
    await client.query(`insert into cases values ${ROWS.join(", ")}`);
    await client.query("grant select on cases, teams to conformance_reader");
    await client.query(
      "create table ledger (id serial primary key, label varchar(20) not null unique, amount numeric(10,2), qty int, paid boolean, due date, at timestamp(6), team int references teams(id), note varchar(5))",
    );
    await client.query(
      "create table pairs (a int, b varchar(10), v int, primary key (a, b), foreign key (a) references teams(id))",
    );
    await client.query(
      "insert into ledger (label, amount, qty, paid, due, at, team, note) values ('L1', 10.50, 1, false, '2026-01-01', '2026-01-01 08:00:00', 1, 'x')",
    );
    await client.query(
      "grant select, insert, update, delete on ledger, pairs to conformance_reader",
    );
    await client.query(
      "grant usage on sequence ledger_id_seq to conformance_reader",
    );
    // A column the database sets on every change, as a trigger keeps it.
    await client.query(`
      create table watched (id int primary key, label varchar(20), changed timestamptz not null default clock_timestamp());
      create function touch_watched() returns trigger language plpgsql as $$ begin new.changed = clock_timestamp(); return new; end $$;
      create trigger watched_touch before update on watched for each row execute function touch_watched();
      insert into watched (id, label) values (1, 'a'), (2, 'b');
      grant select, update on watched to conformance_reader;
      create table approvals (id int primary key, label varchar(20), amount numeric(10,2), due date);
      insert into approvals values (1, 'A1', 10.50, '2026-03-01'), (2, 'A2', 20.00, null);
      grant select, update on approvals to conformance_reader;
      create table staff (id int primary key, name varchar(20), dept varchar(10), salary numeric(10,2));
      insert into staff values (1, 'Ann', 'sales', 100.00), (2, 'Bob', 'ops', 200.00), (3, 'Cy', 'sales', 300.00), (4, 'Di', 'ops', 400.00);
      grant select, update on staff to conformance_reader;
      create schema ag_side;
      grant usage, create on schema ag_side to conformance_reader;
    `);
    await client.end();
    erpUrl = clientUrl.toString();

    const control = await createTestDatabase("conformance");
    db = control.db;
    close = control.close;
    const actor = (
      await db
        .insertInto("users")
        .values({
          email: "admin@example.com",
          displayName: "Admin",
          isAdmin: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    pools = new SourcePools({ db, key, settings, log: () => undefined });
    setSourcePools(pools);
    const deps = { db, key, settings };
    const base = await insertBase(db, actor, { name: "Conformance" });
    actorId = actor;
    baseId = base.id;

    const sources: Array<{
      engine: Engine;
      host: string;
      port: number;
      database: string;
      username: string;
      schema: string;
    }> = [
      {
        engine: "postgres",
        host: new URL(adminUrl).hostname,
        port: Number(new URL(adminUrl).port),
        database: name,
        username: "conformance_reader",
        schema: "public",
      },
      {
        engine: "mysql",
        host: "localhost",
        port: mysqlContainer.getMappedPort(3306),
        database: "erp",
        username: "reader",
        schema: "erp",
      },
      {
        engine: "mariadb",
        host: "localhost",
        port: mariadbContainer.getMappedPort(3306),
        database: "erp",
        username: "reader",
        schema: "erp",
      },
      {
        engine: "sqlserver",
        host: "localhost",
        port: sqlServerContainer.getMappedPort(1433),
        database: "erp",
        username: "reader",
        schema: "dbo",
      },
      {
        engine: "oracle",
        host: "localhost",
        port: oracleContainer.getMappedPort(1521),
        database: "FREEPDB1",
        username: "reader",
        schema: "ERP",
      },
    ];
    for (const source of sources) {
      const created = await createSource(deps, actor, {
        name: `Cases ${source.engine}`,
        engine: source.engine,
        host: source.host,
        port: source.port,
        database: source.database,
        username: source.username,
        password: "readerpass",
        tlsCa: null,
        connectionLimit: 2,
        queryTimeoutMs: 15_000,
        timeZone: "UTC",
      });
      declared.set(source.engine, {
        sourceId: created.id,
        schema: source.schema,
      });
      const {
        tableIds: [groupsId = "", tableId = ""],
      } = await exposeTables(deps, actor, {
        sourceId: created.id,
        baseId: base.id,
        tables: [
          { schema: source.schema, name: "teams" },
          { schema: source.schema, name: "cases" },
        ],
      });
      const columns = new Map<string, string>();
      const failures = new Map<string, string>();
      for (const [index, formula] of [
        ...FORMULAS,
        ...APPROXIMATE,
        JSON_NUMBER,
        ...REGEXES,
        REGEX_AMBIGUOUS,
        ...ERRORS,
      ].entries()) {
        try {
          const column = await addColumn(db, actor, tableId, {
            label: `c${String(index).padStart(3, "0")}`,
            fieldType: "formula",
            formulaSource: formula,
          });
          columns.set(formula, column.name);
        } catch (error) {
          failures.set(
            formula,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const { engine } = await loadEngine(db, tableId, () => true);
      const values = new Map<string, unknown[]>();
      // Forty formulas per page, the client's columns with them: two
      // hundred in one query are more than SQL Server compiles (error 8632,
      // source_query_too_complex).
      const entries = [...columns];
      const pageOf = (wanted: ReadonlySet<string>) =>
        readPage(
          db,
          {
            ...engine,
            table: {
              ...engine.table,
              columns: engine.table.columns.filter(
                (column) => column.physical || wanted.has(column.name),
              ),
            },
          },
          {
            limit: 10,
            sort: [{ column: "f_id", direction: "asc" }],
            timeZone: "Europe/Paris",
          },
          { total: false },
        );
      for (let from = 0; from < entries.length; from += 40) {
        const chunk = entries.slice(from, from + 40);
        const wanted = new Set(chunk.map(([, column]) => column));
        const page = await pageOf(wanted).catch(() => null);
        if (!page) {
          // One formula the engine refuses fails the page: read each alone,
          // so the comparison names it, with what the engine said.
          for (const [formula, column] of chunk) {
            const alone = await pageOf(new Set([column])).catch(
              (error: unknown) => error,
            );
            const rows =
              "rows" in (alone as object)
                ? (alone as Awaited<ReturnType<typeof pageOf>>).rows
                : undefined;
            values.set(
              formula,
              rows ? rows.map((row) => row[column] ?? null) : [failed(alone)],
            );
            values.set(
              `errors ${formula}`,
              rows
                ? rows.map(
                    (row) =>
                      (row.ag_errors as Record<string, unknown> | undefined)?.[
                        column
                      ] ?? null,
                  )
                : [failed(alone)],
            );
          }
          continue;
        }
        for (const [formula, column] of chunk) {
          values.set(
            formula,
            page.rows.map((row) => row[column] ?? null),
          );
          values.set(
            `errors ${formula}`,
            page.rows.map(
              (row) =>
                (row.ag_errors as Record<string, unknown> | undefined)?.[
                  column
                ] ?? null,
            ),
          );
        }
      }
      /** A value of the comparison, or what the engine said instead. */
      const attempt = async (name: string, read: () => Promise<unknown[]>) => {
        values.set(
          name,
          await read().catch((error: unknown) => [failed(error)]),
        );
      };
      await attempt("footer", async () =>
        (
          await aggregateRows(
            db,
            engine,
            { timeZone: "Europe/Paris" },
            FOOTER.map((item) => ({
              column: columnOf(engine, item.column),
              fn: item.fn,
            })),
          )
        ).map(Number),
      );
      for (const [name, condition] of FILTERS) {
        await attempt(`filter ${name}`, async () =>
          (
            await readPage(
              db,
              engine,
              {
                limit: 10,
                timeZone: "Europe/Paris",
                sort: [{ column: "f_id", direction: "asc" }],
                filter: {
                  conjunction: "and",
                  conditions: [
                    {
                      ...condition,
                      column: columnOf(engine, condition.column),
                    } as never,
                  ],
                },
              },
              { total: false },
            )
          ).rows.map((row) => row.id),
        );
      }
      const described = new Map(
        describeColumns(engine).map((column) => [column.name, column]),
      );
      limited.set(
        source.engine,
        new Map(
          [...columns].map(([formula, column]) => [
            formula,
            described.get(column)?.limits ?? [],
          ]),
        ),
      );
      // Lookups and rollups on `groups`, then formulas that read them.
      await addColumn(db, actor, tableId, {
        label: "dup",
        fieldType: "formula",
        formulaSource: 'LEFT({s}, 0) & "x"',
      });
      const groupColumns = new Map<string, string>();
      for (const [label, target, fn, filter] of COMPUTED) {
        try {
          const column = await insertComputed(
            db,
            actor,
            {
              tableId: groupsId,
              label,
              relation: "cases",
              target,
              ...(fn ? { fn: fn as never } : {}),
              ...(filter ? { filter } : {}),
            },
            () => true,
          );
          groupColumns.set(label, column.name);
        } catch (error) {
          failures.set(
            label,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      for (const [index, formula] of GROUP_FORMULAS.entries()) {
        try {
          const column = await addColumn(db, actor, groupsId, {
            label: `g${String(index).padStart(3, "0")}`,
            fieldType: "formula",
            formulaSource: formula,
          });
          groupColumns.set(formula, column.name);
        } catch (error) {
          failures.set(
            formula,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const groups = (await loadEngine(db, groupsId, () => true)).engine;
      const groupPage = (wanted: ReadonlySet<string>) =>
        readPage(
          db,
          {
            ...groups,
            table: {
              ...groups.table,
              columns: groups.table.columns.filter(
                (column) =>
                  column.physical || column.relation || wanted.has(column.name),
              ),
            },
          },
          {
            limit: 10,
            sort: [{ column: "f_id", direction: "asc" }],
            timeZone: "Europe/Paris",
          },
          { total: false },
        );
      const together = await groupPage(new Set(groupColumns.values())).catch(
        () => null,
      );
      for (const [name, column] of groupColumns) {
        await attempt(name, async () =>
          (together ?? (await groupPage(new Set([column])))).rows.map(
            (row) => row[column] ?? null,
          ),
        );
      }
      for (const [name, condition] of LIST_FILTERS) {
        const column = groupColumns.get(condition.column);
        if (!column) {
          values.set(`filter ${name}`, [`no column ${condition.column}`]);
          continue;
        }
        await attempt(`filter ${name}`, async () =>
          (
            await readPage(
              db,
              groups,
              {
                limit: 10,
                timeZone: "Europe/Paris",
                sort: [{ column: "f_id", direction: "asc" }],
                filter: {
                  conjunction: "and",
                  conditions: [{ ...condition, column } as never],
                },
              },
              { total: false },
            )
          ).rows.map((row) => row.id),
        );
      }
      for (const [label, target, fn] of NESTED) {
        try {
          const column = await insertComputed(
            db,
            actor,
            {
              tableId,
              label,
              relation: "g",
              target: groupColumns.get(target) ?? target,
              ...(fn ? { fn: fn as never } : {}),
            },
            () => true,
          );
          const nested = await readPage(
            db,
            (await loadEngine(db, tableId, () => true)).engine,
            {
              limit: 10,
              fields: [column.name],
              sort: [{ column: "f_id", direction: "asc" }],
              timeZone: "Europe/Paris",
            },
            { total: false },
          );
          values.set(
            label,
            nested.rows.map((row) => row[column.name] ?? null),
          );
        } catch (error) {
          failures.set(label, failed(error));
        }
      }
      results.set(source.engine, values);
      refused.set(source.engine, failures);
    }
  }, 600_000);

  afterAll(async () => {
    setSourcePools(undefined);
    await pools?.close();
    await close?.();
    await Promise.all(servers.map((server) => server.stop()));
  });

  it("computes every formula on the reference", () => {
    const reference = results.get("postgres");
    expect(refused.get("postgres")).toEqual(new Map());
    for (const formula of [...FORMULAS, ...ACROSS]) {
      expect(reference?.get(formula), formula).toHaveLength(3);
    }
    for (const [formula, expected] of Object.entries(PINNED)) {
      expect(reference?.get(formula), formula).toEqual(expected);
    }
    // PostgreSQL computes all of it exactly.
    for (const formula of [
      ...FORMULAS,
      ...APPROXIMATE,
      JSON_NUMBER,
      ...REGEXES,
      REGEX_AMBIGUOUS,
      ...ERRORS,
    ]) {
      expect(limited.get("postgres")?.get(formula), formula).toEqual([]);
    }
  });

  it.each(["mysql", "mariadb", "sqlserver", "oracle"] as const)(
    "reads the same on %s, or says it is approximate",
    (engine) => {
      // Oracle stores no empty text: '' is NULL there, and so is a
      // formula's empty result. Both read as a blank cell.
      const blank = (value: unknown): unknown =>
        engine !== "oracle"
          ? value
          : value === ""
            ? null
            : Array.isArray(value)
              ? value.map(blank)
              : value;
      const reference = new Map(
        [...(results.get("postgres") ?? [])].map(([formula, value]) => [
          formula,
          blank(value) as unknown[],
        ]),
      );
      const values = new Map(
        [...(results.get(engine) ?? [])].map(([formula, value]) => [
          formula,
          blank(value) as unknown[],
        ]),
      );
      const differences: string[] = [];
      for (const formula of [
        ...FORMULAS,
        ...ACROSS_COMPARED,
        "footer",
        ...FILTERS.map(([name]) => `filter ${name}`),
        ...ERRORS.flatMap((formula) => [formula, `errors ${formula}`]),
      ]) {
        const expected =
          engine === "oracle" && formula in ORACLE_EMPTY_TEXT
            ? ORACLE_EMPTY_TEXT[formula]
            : reference.get(formula);
        const actual = values.get(formula);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          differences.push(
            `${formula}\n    postgres: ${JSON.stringify(expected)}\n    ${engine}: ${JSON.stringify(actual)}${refused.get(engine)?.has(formula) ? ` (refused: ${refused.get(engine)?.get(formula) ?? ""})` : ""}`,
          );
        }
      }
      for (const formula of [...APPROXIMATE, ...APPROXIMATE_ACROSS]) {
        const expected = reference.get(formula) ?? [];
        const actual = values.get(formula) ?? [];
        if (
          actual.length !== expected.length ||
          expected.some((value, index) => !agrees(value, actual[index]))
        ) {
          differences.push(
            `${formula} (13 digits)\n    postgres: ${JSON.stringify(expected)}\n    ${engine}: ${JSON.stringify(actual)}${refused.get(engine)?.has(formula) ? ` (refused: ${refused.get(engine)?.get(formula) ?? ""})` : ""}`,
          );
        }
      }
      // MySQL reads a JSON number as a double: to 13 digits, and said.
      const number = values.get(JSON_NUMBER) ?? [];
      const exact = reference.get(JSON_NUMBER) ?? [];
      if (
        engine === "mysql"
          ? exact.some((value, index) => !agrees(value, number[index]))
          : JSON.stringify(number) !== JSON.stringify(exact)
      ) {
        differences.push(
          `${JSON_NUMBER}\n    postgres: ${JSON.stringify(exact)}\n    ${engine}: ${JSON.stringify(number)}`,
        );
      }
      // Regular expressions: SQL Server and Oracle refuse them, naming
      // themselves (Oracle lacks lookaheads and `(?:…)`); the others read
      // the same, but where the pattern lets them choose.
      for (const formula of [...REGEXES, REGEX_AMBIGUOUS]) {
        if (engine === "sqlserver" || engine === "oracle") {
          if (!/cannot compute/.test(refused.get(engine)?.get(formula) ?? "")) {
            differences.push(`${formula}\n    not refused on ${engine}`);
          }
          continue;
        }
        const expected =
          formula === REGEX_AMBIGUOUS
            ? ["a", "a", "a"]
            : reference.get(formula);
        if (JSON.stringify(values.get(formula)) !== JSON.stringify(expected)) {
          differences.push(
            `${formula}\n    expected: ${JSON.stringify(expected)}\n    ${engine}: ${JSON.stringify(values.get(formula))}`,
          );
        }
        const said = limited.get(engine)?.get(formula);
        const told =
          formula === REGEX_AMBIGUOUS
            ? [{ code: "regex", engine, fn: "REGEX_EXTRACT" }]
            : [];
        if (JSON.stringify(said) !== JSON.stringify(told)) {
          differences.push(
            `${formula} (limits)\n    expected: ${JSON.stringify(told)}\n    ${engine}: ${JSON.stringify(said)}`,
          );
        }
      }
      expect(differences, differences.join("\n")).toEqual([]);
      const jsonLimit = {
        code: "approximate",
        engine: "mysql",
        fn: "JSON_EXTRACT",
      };
      for (const formula of [...FORMULAS, JSON_NUMBER]) {
        expect(limited.get(engine)?.get(formula), formula).toEqual(
          engine === "mysql" && formula.includes("JSON_EXTRACT(")
            ? [jsonLimit]
            : [],
        );
      }
      for (const formula of APPROXIMATE) {
        const fn = /^[A-Z]+/.exec(formula)?.[0];
        // On SQL Server the floating result is a wide decimal: what is
        // computed from it may be rounded too.
        expect(limited.get(engine)?.get(formula), formula).toContainEqual({
          code: "approximate",
          engine,
          fn,
        });
      }
    },
  );
  it("writes to client tables, comparing what each person saw", async () => {
    const deps = { db, key, settings };
    const services = {
      db,
      bus: { publish: () => Promise.resolve() } as never,
      log: () => undefined,
    };
    const meta = { source: "web" };
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => "ok",
        (error: unknown) =>
          error instanceof AppError ? error.code : String(error),
      );
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      const trace: unknown[] = [];
      const {
        tableIds: [ledgerId = "", pairsId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId,
        tables: [
          { schema, name: "ledger" },
          { schema, name: "pairs" },
        ],
      });
      const scopeOf = async (tableId: string) =>
        loadRowScope(
          db,
          {
            userId: actorId,
            bindings: [{ role: "owner", scope: "base", scopeId: baseId }],
          },
          await db
            .selectFrom("dataTables")
            .selectAll()
            .where("id", "=", tableId)
            .executeTakeFirstOrThrow(),
        );
      let scope = await scopeOf(ledgerId);
      const field = (physical: string) => columnOf(scope.engine, physical);
      const read = async (ids: string[]) =>
        (
          await readPage(
            db,
            scope.engine,
            {
              rowIds: ids,
              limit: 10,
              sort: [{ column: field("id"), direction: "asc" }],
              timeZone: "UTC",
            },
            { total: false },
          )
        ).rows.map((row) =>
          Object.fromEntries(
            [
              "id",
              "label",
              "amount",
              "qty",
              "paid",
              "due",
              "at",
              "team",
              "note",
            ].map((name) => {
              const value = row[field(name)] ?? null;
              return [
                name,
                Array.isArray(value)
                  ? value.map((item: { id: unknown }) => item.id)
                  : value,
              ];
            }),
          ),
        );

      // Read-only until an administrator enables writes.
      trace.push(
        await failure(
          updateRows(
            services,
            scope,
            [{ rowId: "1", values: { [field("qty")]: "2" } }],
            meta,
          ),
        ),
      );
      for (const tableId of [ledgerId, pairsId]) {
        await setTableWrites(deps, actorId, {
          tableId,
          update: true,
          insert: true,
          delete: true,
        });
      }
      scope = await scopeOf(ledgerId);

      // A row added, its key given back by the engine.
      const [added = ""] = await createRows(
        services,
        scope,
        [
          {
            values: {
              [field("label")]: "L2",
              [field("amount")]: "7.5",
              [field("qty")]: "3",
              [field("paid")]: true,
              [field("due")]: "2026-03-01",
              [field("at")]: "2026-03-01T12:30:00.000Z",
            },
            links: [{ column: field("team"), targetIds: ["2"] }],
          },
        ],
        meta,
      );
      trace.push(added, await read([added]));

      // Changed as seen; refused once it moved, the row left as it was.
      await updateRows(
        services,
        scope,
        [
          {
            rowId: added,
            values: { [field("qty")]: "4", [field("note")]: "ok" },
            expected: { [field("qty")]: "3", [field("note")]: null },
          },
        ],
        meta,
      );
      trace.push(
        await failure(
          updateRows(
            services,
            scope,
            [
              {
                rowId: added,
                values: { [field("qty")]: "5" },
                expected: { [field("qty")]: "3" },
              },
            ],
            meta,
          ),
        ),
        await read([added]),
      );

      // What the engine refuses, said plainly.
      const refused = async (
        values: Record<string, unknown>,
        links?: string[],
      ) =>
        failure(
          updateRows(
            services,
            scope,
            [
              {
                rowId: added,
                values: values as never,
                ...(links
                  ? { links: [{ column: field("team"), targetIds: links }] }
                  : {}),
              },
            ],
            meta,
          ),
        );
      trace.push(
        await refused({ [field("label")]: "L1" }),
        await refused({ [field("note")]: "abcdefgh" }),
        await refused({ [field("label")]: null }),
        await refused({ [field("qty")]: "1.5" }),
        await refused({}, ["99"]),
        await read([added]),
      );

      // A key of two columns.
      const pairs = await scopeOf(pairsId);
      const pair = (physical: string) => columnOf(pairs.engine, physical);
      const [pairId = ""] = await createRows(
        services,
        pairs,
        [{ values: { [pair("a")]: "1", [pair("b")]: "x", [pair("v")]: "1" } }],
        meta,
      );
      await updateRows(
        services,
        pairs,
        [{ rowId: pairId, values: { [pair("v")]: "2" } }],
        meta,
      );
      const pairRows = await readPage(
        db,
        pairs.engine,
        { limit: 10, timeZone: "UTC" },
        { total: false },
      );
      trace.push(pairRows.rows.map((row) => row[pair("v")]));
      // The team lists its pairs, whose ids hold two key columns: T-SQL
      // aggregates no subquery, so the ids are built before STRING_AGG.
      const teamsTable = await db
        .selectFrom("dataTables")
        .select("id")
        .where("sourceId", "=", sourceId)
        .where("externalName", "=", "teams")
        .where("deletedAt", "is", null)
        .executeTakeFirstOrThrow();
      const teams = (await loadEngine(db, teamsTable.id, () => true)).engine;
      const listing = teams.table.columns.find(
        (column) => column.relation?.targetTableId === pairsId,
      );
      const [team] = (
        await readPage(
          db,
          teams,
          { rowIds: ["1"], limit: 1, timeZone: "UTC" },
          { total: false },
        )
      ).rows;
      const teamPairs = listing
        ? (team?.[listing.name] as Array<{ label: string }> | undefined)?.map(
            (link) => link.label,
          )
        : "no link";
      await deleteRows(services, pairs, [pairId], meta);
      trace.push(
        (
          await readPage(
            db,
            pairs.engine,
            { limit: 10, timeZone: "UTC" },
            { total: false },
          )
        ).rows.length,
      );

      // Every applied write is confirmed by reading its row again.
      await settleExternalWrites(db, () => undefined);
      await deleteRows(services, scope, [added], meta);
      trace.push(await read([added]));
      await settleExternalWrites(db, () => undefined);

      // The trail: each write, then its steps.
      const writes = await db
        .selectFrom("externalWrites as w")
        .select([
          "w.id",
          "w.action",
          "w.tableId",
          "w.oldValue",
          "w.newValue",
          "w.requestedAt",
        ])
        .where("w.tableId", "in", [ledgerId, pairsId])
        .orderBy("w.requestedAt")
        .orderBy("w.id")
        .execute();
      const steps = await db
        .selectFrom("externalWriteSteps")
        .select(["writeId", "step"])
        .where(
          "writeId",
          "in",
          writes.map((write) => write.id),
        )
        .execute();
      trace.push(
        writes.map((write) => [
          write.tableId === ledgerId ? "ledger" : "pairs",
          write.action,
          steps
            .filter((step) => step.writeId === write.id)
            .map((step) => step.step)
            .sort(),
        ]),
      );

      // A row of defaults only: the engine says what it requires (MySQL
      // and MariaDB take no DEFAULT VALUES).
      trace.push(
        await failure(createRows(services, scope, [{ values: {} }], meta)),
      );
      // A link given as a list of ids, as a new row's form sends it.
      const [listed = ""] = await createRows(
        services,
        scope,
        [
          {
            values: {
              [field("label")]: "L3",
              [field("team")]: ["3"] as never,
            },
          },
        ],
        meta,
      );
      trace.push((await read([listed]))[0]?.team, teamPairs);
      await deleteRows(services, scope, [listed], meta);
      traces.set(engine, trace);
    }

    const reference = traces.get("postgres");
    expect(reference?.[0]).toBe("external_table_read_only");
    expect(reference?.[1]).toBe("2");
    expect(reference?.[2]).toEqual([
      {
        id: "2",
        label: "L2",
        // A stored number keeps its column's scale.
        amount: "7.50",
        qty: "3",
        paid: true,
        due: "2026-03-01",
        at: "2026-03-01T12:30:00+00:00",
        team: ["2"],
        note: null,
      },
    ]);
    expect(reference?.slice(3, 5)).toEqual([
      "source_conflict",
      [expect.objectContaining({ qty: "4", note: "ok" })],
    ]);
    expect(reference?.slice(5, 10)).toEqual([
      "source_value_duplicate",
      "source_value_too_long",
      "source_value_required",
      "source_value_invalid",
      "source_value_reference",
    ]);
    expect(reference?.slice(11, 14)).toEqual([["2"], 0, []]);
    const confirmed = ["applied", "confirmed"];
    expect(reference?.[14]).toEqual([
      ["ledger", "insert", confirmed],
      ["ledger", "update", confirmed],
      ["ledger", "update", ["abandoned"]],
      ["ledger", "update", ["abandoned"]],
      ["ledger", "update", ["abandoned"]],
      ["ledger", "update", ["abandoned"]],
      ["pairs", "insert", confirmed],
      ["pairs", "update", confirmed],
      ["pairs", "delete", confirmed],
      ["ledger", "delete", confirmed],
    ]);
    expect(reference?.slice(15)).toEqual([
      "source_value_required",
      ["3"],
      ["x"],
    ]);
    for (const engine of ["mysql", "mariadb", "sqlserver", "oracle"] as const) {
      expect(asRead(engine, traces.get(engine)), engine).toEqual(
        asRead(engine, reference),
      );
    }
  }, 300_000);

  it("keeps the fields AnyGridDB adds in a side table, joined where the rows live", async () => {
    const deps = { db, key, settings };
    const services = {
      db,
      bus: { publish: () => Promise.resolve() } as never,
      log: () => undefined,
    };
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => "ok",
        (error: unknown) =>
          error instanceof AppError ? error.code : String(error),
      );
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId }] of declared) {
      const trace: unknown[] = [];
      const teamsTable = await db
        .selectFrom("dataTables")
        .selectAll()
        .where("sourceId", "=", sourceId)
        .where("externalName", "=", "teams")
        .where("deletedAt", "is", null)
        .executeTakeFirstOrThrow();
      // No side schema yet: the field is kept in AnyGridDB's database, by
      // the row's key (ADR 0046). A view filters on it; it never sorts.
      const remarque = await addColumn(db, actorId, teamsTable.id, {
        label: "Remarque",
        fieldType: "text",
      });
      const keptScope = await loadRowScope(
        db,
        {
          userId: actorId,
          bindings: [{ role: "owner", scope: "base", scopeId: baseId }],
        },
        await db
          .selectFrom("dataTables")
          .selectAll()
          .where("id", "=", teamsTable.id)
          .executeTakeFirstOrThrow(),
      );
      trace.push(
        await failure(
          updateRows(
            services,
            keptScope,
            [
              { rowId: "1", values: { [remarque.name]: "Vue" } },
              { rowId: "3", values: { [remarque.name]: "Revue" } },
            ],
            { source: "web" },
          ),
        ),
      );
      const remarks = async (spec: Record<string, unknown> = {}) =>
        (
          await readPage(
            db,
            (await loadEngine(db, teamsTable.id, () => true)).engine,
            { limit: 10, timeZone: "UTC", ...spec },
            { total: true },
          )
        ).rows
          .map((row): [string, unknown] => [row.id, row[remarque.name] ?? null])
          .sort((left, right) => left[0].localeCompare(right[0]));
      const remarkIs = (op: string, value?: string) => ({
        filter: {
          conjunction: "and",
          conditions: [{ column: remarque.name, op, value }],
        },
      });
      trace.push(
        await remarks(),
        await remarks(remarkIs("is", "vue")),
        await remarks(remarkIs("is_empty")),
        await failure(
          remarks({ sort: [{ column: remarque.name, direction: "asc" }] }),
        ),
        // Compared under the lock of its row in AnyGridDB.
        await failure(
          updateRows(
            services,
            keptScope,
            [
              {
                rowId: "1",
                values: { [remarque.name]: "Tard" },
                expected: { [remarque.name]: null },
              },
            ],
            { source: "web" },
          ),
        ),
      );
      // On Oracle, a schema is an account: AnyGridDB's fields go in its own.
      await updateSource(deps, actorId, {
        id: sourceId,
        sideSchema: engine === "oracle" ? "READER" : "ag_side",
      });
      // A field stays where it was made: naming a side schema moves none.
      trace.push(await remarks());
      const statut = await addColumn(db, actorId, teamsTable.id, {
        label: "Statut",
        fieldType: "single_select",
        options: ["Actif", "Pause"],
      });
      const score = await addColumn(db, actorId, teamsTable.id, {
        label: "Score",
        fieldType: "number",
      });
      const scope = await loadRowScope(
        db,
        {
          userId: actorId,
          bindings: [{ role: "owner", scope: "base", scopeId: baseId }],
        },
        await db
          .selectFrom("dataTables")
          .selectAll()
          .where("id", "=", teamsTable.id)
          .executeTakeFirstOrThrow(),
      );
      // The client's table takes no writes: AnyGridDB's own fields do.
      trace.push(
        await failure(
          updateRows(
            services,
            scope,
            [
              {
                rowId: "1",
                values: { [statut.name]: "Actif", [score.name]: "12.50" },
                expected: { [statut.name]: null },
              },
              { rowId: "2", values: { [statut.name]: "Pause" } },
            ],
            { source: "web" },
          ),
        ),
      );
      const read = async (filter?: unknown) =>
        (
          await readPage(
            db,
            (await loadEngine(db, teamsTable.id, () => true)).engine,
            {
              limit: 10,
              timeZone: "UTC",
              sort: [{ column: score.name, direction: "desc" }],
              ...(filter ? { filter: filter as never } : {}),
            },
            { total: true },
          )
        ).rows.map((row) => [row.id, row[statut.name], row[score.name]]);
      trace.push(
        await read(),
        await read({
          conjunction: "and",
          conditions: [{ column: statut.name, op: "is", value: "Actif" }],
        }),
      );
      // A stale value is refused, as for a client's own column.
      trace.push(
        await failure(
          updateRows(
            services,
            scope,
            [
              {
                rowId: "1",
                values: { [statut.name]: "Pause" },
                expected: { [statut.name]: "Pause" },
              },
            ],
            { source: "web" },
          ),
        ),
      );
      // A lookup from the cases reads it through their link.
      const casesId = (
        await db
          .selectFrom("dataTables")
          .select("id")
          .where("sourceId", "=", sourceId)
          .where("externalName", "=", "cases")
          .where("deletedAt", "is", null)
          .executeTakeFirstOrThrow()
      ).id;
      const relation = (
        await loadEngine(db, casesId, () => true)
      ).engine.table.columns.find(
        (column) => column.relation?.targetTableId === teamsTable.id,
      );
      const looked = await insertComputed(
        db,
        actorId,
        {
          tableId: casesId,
          label: "Statut équipe",
          relation: relation?.name ?? "",
          target: statut.name,
        },
        () => true,
      );
      const cases = await readPage(
        db,
        (await loadEngine(db, casesId, () => true)).engine,
        {
          limit: 3,
          timeZone: "UTC",
          sort: [{ column: "f_id", direction: "asc" }],
        },
        { total: false },
      );
      trace.push(cases.rows.map((row) => row[looked.name]));
      traces.set(engine, trace);
    }
    const reference = traces.get("postgres");
    const remarked = [
      ["1", "Vue"],
      ["2", null],
      ["3", "Revue"],
    ];
    expect(reference?.slice(0, 11)).toEqual([
      "ok",
      remarked,
      [["1", "Vue"]],
      [["2", null]],
      "control_plane_sort",
      "source_conflict",
      remarked,
      "ok",
      [
        ["1", "Actif", "12.5"],
        ["2", "Pause", null],
        ["3", null, null],
      ],
      [["1", "Actif", "12.5"]],
      "source_conflict",
    ]);
    for (const engine of ["mysql", "mariadb", "sqlserver", "oracle"] as const) {
      expect(asRead(engine, traces.get(engine)), engine).toEqual(
        asRead(engine, reference),
      );
    }
  }, 300_000);

  it("tells changes other applications make, once each", async () => {
    const deps = { db, key, settings };
    const { bus, published } = recordingBus();
    const watchDeps = { db, bus, log: () => undefined };
    const services = { db, bus, log: () => undefined };
    const told = () =>
      published
        .map(
          (item) =>
            item.message as { type: string; op?: string; rowIds?: string[] },
        )
        .filter((message) => message.type === "rows")
        .map((message) => [message.op, message.rowIds])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      const {
        tableIds: [tableId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId,
        tables: [{ schema, name: "watched" }],
      });
      await setTableWrites(deps, actorId, {
        tableId,
        update: true,
        insert: false,
        delete: false,
      });
      // SQL Server tells by Change Tracking; the others by their column.
      await setTableWatch(
        deps,
        actorId,
        engine === "sqlserver"
          ? { tableId, method: "change_tracking", intervalSeconds: 5 }
          : {
              tableId,
              method: "column",
              column: "changed",
              intervalSeconds: 5,
            },
      );
      const trace: unknown[] = [];
      // The first check takes its bearings: nothing there is a change.
      trace.push(await runWatch(watchDeps, tableId), told());
      published.length = 0;
      for (const statement of [
        "update watched set label = 'x' where id = 1",
        "insert into watched (id, label) values (3, 'c')",
        "delete from watched where id = 2",
      ]) {
        await outside(engine, statement);
      }
      trace.push(await runWatch(watchDeps, tableId), told());
      const watch = await db
        .selectFrom("externalWatches")
        .select(["changes", "errorCode"])
        .where("tableId", "=", tableId)
        .executeTakeFirstOrThrow();
      trace.push(watch);
      // Nothing more happened: a check finds nothing again.
      published.length = 0;
      await runWatch(watchDeps, tableId);
      trace.push(told());
      // AnyGridDB's own write sent its events already: not told again.
      const scope = await loadRowScope(
        db,
        {
          userId: actorId,
          bindings: [{ role: "owner", scope: "base", scopeId: baseId }],
        },
        await db
          .selectFrom("dataTables")
          .selectAll()
          .where("id", "=", tableId)
          .executeTakeFirstOrThrow(),
      );
      const label = columnOf(scope.engine, "label");
      await updateRows(
        services,
        scope,
        [{ rowId: "1", values: { [label]: "own" } }],
        { source: "web" },
      );
      published.length = 0;
      await runWatch(watchDeps, tableId);
      trace.push(told());
      traces.set(engine, trace);
    }
    const byColumn = [
      5,
      [],
      5,
      // A column tells no delete.
      [
        ["insert", ["3"]],
        ["update", ["1"]],
      ],
      { changes: 2, errorCode: null },
      [],
      [],
    ];
    for (const engine of ["postgres", "mysql", "mariadb", "oracle"] as const) {
      expect(traces.get(engine), engine).toEqual(byColumn);
    }
    expect(traces.get("sqlserver")).toEqual([
      5,
      [],
      5,
      [
        ["delete", ["2"]],
        ["insert", ["3"]],
        ["update", ["1"]],
      ],
      { changes: 3, errorCode: null },
      [],
      [],
    ]);
  }, 300_000);

  it("seals locked client rows and tells a change made elsewhere", async () => {
    const deps = { db, key, settings };
    const services = { db, bus: recordingBus().bus, log: () => undefined };
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => "ok",
        (error: unknown) =>
          error instanceof AppError ? error.code : String(error),
      );
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      const trace: unknown[] = [];
      const {
        tableIds: [tableId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId,
        tables: [{ schema, name: "approvals" }],
      });
      await setTableWrites(deps, actorId, {
        tableId,
        update: true,
        insert: false,
        delete: false,
      });
      const table = await db
        .selectFrom("dataTables")
        .selectAll()
        .where("id", "=", tableId)
        .executeTakeFirstOrThrow();
      const scope = await loadRowScope(
        db,
        {
          userId: actorId,
          bindings: [{ role: "owner", scope: "base", scopeId: baseId }],
        },
        table,
      );
      const owner = { ...scope, role: "owner" as const };
      const field = (physical: string) => columnOf(scope.engine, physical);
      const told: unknown[] = [];
      const sealDeps = {
        db,
        log: () => undefined,
        notify: (items: unknown[]) => {
          told.push(...items);
          return Promise.resolve();
        },
      };
      const state = () =>
        db
          .selectFrom("externalStatuses")
          .select(["status", "fingerprint", "sealed", "drift"])
          .where("tableId", "=", tableId)
          .where("rowId", "=", "1")
          .executeTakeFirst();
      const byPhysical = (values: unknown) =>
        Object.fromEntries(
          Object.entries((values ?? {}) as Record<string, unknown>).map(
            ([name, value]) => [
              scope.engine.table.columns.find((column) => column.name === name)
                ?.physical?.name ?? name,
              value,
            ],
          ),
        );
      const statuses = async () => {
        const rows = (
          await readPage(
            db,
            scope.engine,
            { rowIds: ["1", "2"], limit: 10, timeZone: "UTC" },
            { total: false },
          )
        ).rows;
        const drifts = await attachExternalStatuses(db, scope.engine, rows);
        return rows
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((row) => [
            row.id,
            row.ag_status,
            drifts
              .get(row.id)
              ?.fields.map((name) => Object.keys(byPhysical({ [name]: 1 }))[0]),
          ]);
      };
      const status = (rowId: string, next: "submitted" | "locked" | "draft") =>
        failure(changeStatus(services, owner, rowId, next, { source: "web" }));
      const sign = () =>
        failure(
          signExternalRow(db, {
            userId: actorId,
            table,
            rowId: "1",
            meaning: "Approuvé",
            source: "web",
            depth: 0,
          }),
        );
      const edit = (rowId: string) =>
        failure(
          updateRows(
            services,
            scope,
            [{ rowId, values: { [field("label")]: `${rowId}b` } }],
            { source: "web" },
          ),
        );

      // Every row of a keyed client table is a draft until submitted.
      trace.push(await statuses());
      // Locking needs a submitted row, and an owner.
      trace.push(await status("1", "locked"));
      trace.push(await status("1", "submitted"));
      trace.push(
        await failure(
          setExternalStatus(db, {
            userId: actorId,
            role: "editor",
            table,
            rowId: "1",
            status: "locked",
            source: "web",
            depth: 0,
          }),
        ),
      );
      trace.push(await status("1", "locked"));
      const locked = await state();
      trace.push(
        locked?.status,
        /^[0-9a-f]{64}$/.test(locked?.fingerprint ?? ""),
      );
      trace.push(byPhysical(locked?.sealed));
      // AnyGridDB refuses its own writes to a locked row, not to the others.
      trace.push(await edit("1"), await edit("2"));
      // Nothing moved: a check finds nothing to tell.
      trace.push(await checkSeals(sealDeps, { tableId, rowIds: ["1"] }));
      trace.push((await state())?.drift ?? null, told.length);

      // Another application changes the locked row.
      await outside(engine, "update approvals set amount = 11.25 where id = 1");
      await checkSeals(sealDeps);
      trace.push(
        byPhysical(
          Object.fromEntries(
            (
              ((await state())?.drift as { fields?: string[] } | null)
                ?.fields ?? []
            ).map((name) => [name, true]),
          ),
        ),
      );
      trace.push(
        told.length > 0,
        (told[0] as { kind?: string } | undefined)?.kind,
      );
      trace.push(await statuses());
      // Signing compares first: the row no longer holds what was sealed.
      trace.push(await sign());
      // Put back, the row is told restored, and may be signed.
      await outside(engine, "update approvals set amount = 10.50 where id = 1");
      await checkSeals(sealDeps, { tableId, rowIds: ["1"] });
      trace.push((await state())?.drift ?? null);
      trace.push(await sign());
      const signature = await db
        .selectFrom("rowSignatures")
        .select(["recordId", "fingerprint", "meaning"])
        .where("tableId", "=", tableId)
        .executeTakeFirst();
      trace.push(
        signature?.recordId,
        signature?.meaning,
        signature?.fingerprint === locked?.fingerprint,
      );
      trace.push((await state())?.status, await edit("1"));
      // Deleted elsewhere: told missing.
      await outside(engine, "delete from approvals where id = 1");
      await checkSeals(sealDeps, { tableId, rowIds: ["1"] });
      trace.push((await state())?.drift);
      // An owner unlocks: the row is a draft again, the trail stays.
      trace.push(await status("1", "draft"));
      trace.push((await state()) ?? null);
      const events = await db
        .selectFrom("externalStatusEvents")
        .select(["action", "userId", "fingerprint"])
        .where("tableId", "=", tableId)
        .where("rowId", "=", "1")
        .orderBy("at")
        .orderBy("id")
        .execute();
      trace.push(
        events.map((event) => [
          event.action,
          event.userId === null ? "check" : "person",
          event.fingerprint === null
            ? null
            : event.fingerprint === locked?.fingerprint,
        ]),
      );
      if (engine === "postgres") {
        // A lock waits for a write recorded before it, then seals.
        trace.push(await status("2", "submitted"));
        const write = await db
          .insertInto("externalWrites")
          .values({
            userId: actorId,
            tableId,
            sourceId,
            rowId: "2",
            action: "update",
            oldValue: {},
            newValue: {},
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const started = Date.now();
        const locking = status("2", "locked");
        await new Promise((resolve) => setTimeout(resolve, 600));
        // Meanwhile the row reads locked: a write checking now is refused.
        trace.push(
          await failure(
            updateRows(
              services,
              scope,
              [{ rowId: "2", values: { [field("label")]: "late" } }],
              { source: "web" },
            ),
          ),
        );
        await db
          .insertInto("externalWriteSteps")
          .values({ writeId: write.id, step: "abandoned", detail: null })
          .execute();
        trace.push(await locking, Date.now() - started >= 600);
        trace.push(await status("2", "draft"));
      }
      traces.set(engine, trace);
      // Back for the next engine's run, should the suite be repeated.
      await outside(
        engine,
        engine === "sqlserver"
          ? "insert into approvals values (1, N'A1', 10.50, '2026-03-01')"
          : "insert into approvals values (1, 'A1', 10.50, '2026-03-01')",
      );
    }
    const reference = traces.get("postgres");
    expect(reference?.slice(-5)).toEqual([
      "ok",
      "row_locked",
      "ok",
      true,
      "ok",
    ]);
    reference?.splice(-5);
    expect(reference).toEqual([
      [
        ["1", "draft", undefined],
        ["2", "draft", undefined],
      ],
      "invalid_status",
      "ok",
      "invalid_status",
      "ok",
      "locked",
      true,
      { id: "1", label: "A1", amount: "10.5", due: "2026-03-01" },
      "row_locked",
      "ok",
      1,
      null,
      0,
      { amount: true },
      true,
      "row_changed",
      [
        ["1", "locked", ["amount"]],
        ["2", "draft", undefined],
      ],
      "row_changed_elsewhere",
      null,
      "ok",
      "1",
      "Approuvé",
      true,
      "signed",
      "row_locked",
      { missing: true, fields: [] },
      "ok",
      null,
      [
        ["submit", "person", null],
        ["lock", "person", true],
        ["changed", "check", null],
        ["restored", "check", null],
        ["sign", "person", true],
        ["changed", "check", null],
        ["unlock", "person", true],
      ],
    ]);
    for (const engine of ["mysql", "mariadb", "sqlserver", "oracle"] as const) {
      expect(asRead(engine, traces.get(engine)), engine).toEqual(
        asRead(engine, reference),
      );
    }
  }, 300_000);

  it("applies field and row rules where the rows live", async () => {
    const deps = { db, key, settings };
    const services = { db, bus: recordingBus().bus, log: () => undefined };
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => "ok",
        (error: unknown) =>
          error instanceof AppError ? error.code : String(error),
      );
    const member = (
      await db
        .insertInto("users")
        .values({ email: "member@example.com", displayName: "Member" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const bindings = [
      { role: "editor" as const, scope: "base" as const, scopeId: baseId },
    ];
    await withAudit(db, { userId: actorId, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({
          userId: member,
          role: "editor",
          scope: "base",
          scopeId: baseId,
        })
        .execute(),
    );
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      const trace: unknown[] = [];
      const {
        tableIds: [tableId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId,
        tables: [{ schema, name: "staff" }],
      });
      await setTableWrites(deps, actorId, {
        tableId,
        update: true,
        insert: false,
        delete: false,
      });
      const owned = await loadEngine(db, tableId, () => true);
      const field = (physical: string) => columnOf(owned.engine, physical);
      // Sales only; salaries hidden; names read-only.
      await setTableAcl(db, actorId, {
        tableId,
        userId: member,
        rowFilter: {
          conjunction: "and",
          conditions: [{ column: field("dept"), op: "is", value: "sales" }],
        },
        // A field the rules do not name is hidden: each one is named.
        columns: [
          { column: field("id"), access: "read" },
          { column: field("dept"), access: "write" },
          { column: field("salary"), access: "hide" },
          { column: field("name"), access: "read" },
        ],
      });
      const { engine: reader } = await readerEngine(db, tableId, {
        userId: member,
        bindings,
      });
      const fields = visibleFields(reader);
      const page = (filter?: Parameters<typeof readPage>[2]["filter"]) =>
        readPage(
          db,
          reader,
          {
            ...(filter ? { filter } : {}),
            ...(fields ? { fields } : {}),
            sort: [{ column: field("id"), direction: "asc" }],
            limit: 10,
            timeZone: "UTC",
          },
          { total: true },
        );
      const all = await page();
      trace.push(
        all.total,
        all.rows.map((row) => [
          row.id,
          row[field("name")],
          field("salary") in row,
        ]),
      );
      // A hidden field filters as empty: its values do not leak.
      const rich = await page({
        conjunction: "and",
        conditions: [{ column: field("salary"), op: "gt", value: "150" }],
      });
      trace.push(rich.total);
      // Aggregates count what the reader may see.
      trace.push(
        await aggregateRows(db, reader, { timeZone: "UTC" }, [
          { column: field("id"), fn: "count_all" },
        ]),
      );
      // Writes: a read-only field, a row outside the rule, a writable one.
      const table = await db
        .selectFrom("dataTables")
        .selectAll()
        .where("id", "=", tableId)
        .executeTakeFirstOrThrow();
      const scope = await loadRowScope(db, { userId: member, bindings }, table);
      const edit = (rowId: string, name: string, value: string) =>
        failure(
          updateRows(
            services,
            scope,
            [{ rowId, values: { [field(name)]: value } }],
            { source: "web" },
          ),
        );
      trace.push(
        await edit("1", "name", "Anne"),
        await edit("2", "dept", "ops"),
        await edit("1", "dept", "sales"),
        await edit("3", "salary", "1"),
      );
      traces.set(engine, trace);
    }
    const reference = traces.get("postgres");
    expect(reference).toEqual([
      2,
      [
        ["1", "Ann", false],
        ["3", "Cy", false],
      ],
      0,
      [2],
      "access_denied",
      "access_denied",
      "ok",
      "access_denied",
    ]);
    for (const engine of ["mysql", "mariadb", "sqlserver", "oracle"] as const) {
      expect(asRead(engine, traces.get(engine)), engine).toEqual(
        asRead(engine, reference),
      );
    }
  }, 300_000);

  it("reads a synced table from its copy, and tells what changed", async () => {
    const deps = { db, key, settings };
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => "ok",
        (error: unknown) =>
          error instanceof AppError ? error.code : String(error),
      );
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      const trace: unknown[] = [];
      const { bus, published } = recordingBus();
      const syncDeps = { db, bus, log: () => undefined };
      // A base of its own: these tables are exposed elsewhere already.
      const base = await insertBase(db, actorId, { name: `Sync ${engine}` });
      const {
        tableIds: [casesId = "", teamsId = "", staffId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId: base.id,
        tables: [
          { schema, name: "cases" },
          { schema, name: "teams" },
          { schema, name: "staff" },
        ],
      });
      const read = async (tableId: string) => {
        const { engine: catalog } = await loadEngine(db, tableId, () => true);
        const page = await readPage(
          db,
          catalog,
          {
            sort: [{ column: columnOf(catalog, "id"), direction: "asc" }],
            limit: 50,
            timeZone: "UTC",
          },
          { total: true },
        );
        return {
          synced: catalog.table.external?.synced === true,
          total: page.total,
          rows: page.rows.map((row) =>
            Object.fromEntries(
              Object.entries(row).filter(([name]) => !name.startsWith("ag_")),
            ),
          ),
        };
      };
      const live = await read(casesId);
      // Both ends of the link are copied: it reads in the copy too.
      for (const tableId of [teamsId, casesId, staffId]) {
        await setTableSync(db, actorId, { tableId, intervalMinutes: 15 });
        trace.push(await runSync(syncDeps, tableId));
      }
      const copied = await read(casesId);
      trace.push(live.synced, copied.synced, copied.total === live.total);
      expect(copied.rows, engine).toEqual(live.rows);
      // Teams read live again: a copy cannot join them, the link reads
      // empty and the rest of the row as before.
      await setTableSync(db, actorId, {
        tableId: teamsId,
        intervalMinutes: null,
      });
      const { engine: casesEngine } = await loadEngine(db, casesId, () => true);
      const team = columnOf(casesEngine, "g");
      const apart = await read(casesId);
      trace.push(
        apart.rows.every(
          (row) => Array.isArray(row[team]) && row[team].length === 0,
        ),
        apart.rows.map((row) => ({ ...row, [team]: null })),
      );
      expect(apart.rows.map((row) => ({ ...row, [team]: null }))).toEqual(
        live.rows.map((row) => ({ ...row, [team]: null })),
      );
      trace.pop();

      // Another application adds, changes, and deletes rows.
      await outside(
        engine,
        engine === "sqlserver"
          ? "update staff set name = N'Ann B' where id = 1; insert into staff values (5, N'Eve', N'ops', 500.00); delete from staff where id = 4"
          : "update staff set name = 'Ann B' where id = 1; insert into staff values (5, 'Eve', 'ops', 500.00); delete from staff where id = 4",
      );
      published.length = 0;
      trace.push(await runSync(syncDeps, staffId));
      trace.push(
        published
          .map(
            (item) =>
              item.message as { type: string; op?: string; rowIds?: string[] },
          )
          .filter((message) => message.type === "rows")
          .map((message) => [message.op, message.rowIds])
          .sort((left, right) =>
            String(left[0]).localeCompare(String(right[0])),
          ),
      );
      const state = await db
        .selectFrom("externalSyncs")
        .select(["changes", "rowCount", "errorCode"])
        .where("tableId", "=", staffId)
        .executeTakeFirstOrThrow();
      trace.push(state);
      const staff = await read(staffId);
      const { engine: staffEngine } = await loadEngine(db, staffId, () => true);
      trace.push(
        staff.rows.map((row) => [row.id, row[columnOf(staffEngine, "name")]]),
      );
      // A copy takes no writes.
      const table = await db
        .selectFrom("dataTables")
        .selectAll()
        .where("id", "=", staffId)
        .executeTakeFirstOrThrow();
      const scope = await loadRowScope(
        db,
        {
          userId: actorId,
          bindings: [{ role: "owner", scope: "base", scopeId: base.id }],
        },
        table,
      );
      trace.push(
        await failure(
          updateRows(
            { db, bus, log: () => undefined },
            scope,
            [{ rowId: "1", values: { [columnOf(staffEngine, "name")]: "x" } }],
            { source: "web" },
          ),
        ),
      );
      // Live again: the copy is gone, and the client's table is read.
      await setTableSync(db, actorId, {
        tableId: staffId,
        intervalMinutes: null,
      });
      trace.push((await read(staffId)).synced);
      // The copy goes once reads on it ended (the job a minute later).
      await dropUnusedCopy(db, staffId);
      const { rows: copies } = await sql<{ name: string }>`
        select tablename as "name" from pg_tables where schemaname = 'ag_sync'
      `.execute(db);
      trace.push(
        copies.some((row) => row.name.includes(staffId.replaceAll("-", ""))),
      );
      traces.set(engine, trace);
    }
    const reference = traces.get("postgres");
    expect(reference).toEqual([
      900,
      900,
      900,
      false,
      true,
      true,
      true,
      900,
      [
        ["delete", ["4"]],
        ["insert", ["5"]],
        ["update", ["1"]],
      ],
      { changes: 3, rowCount: "4", errorCode: null },
      [
        ["1", "Ann B"],
        ["2", "Bob"],
        ["3", "Cy"],
        ["5", "Eve"],
      ],
      "external_table_synced",
      false,
      false,
    ]);
    for (const engine of ["mysql", "mariadb", "sqlserver", "oracle"] as const) {
      expect(asRead(engine, traces.get(engine)), engine).toEqual(
        asRead(engine, reference),
      );
    }
  }, 300_000);

  it("refreshes a synced table by its change column", async () => {
    const deps = { db, key, settings };
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => "ok",
        (error: unknown) =>
          error instanceof AppError ? error.code : String(error),
      );
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      const trace: unknown[] = [];
      const syncDeps = { db, bus: recordingBus().bus, log: () => undefined };
      const base = await insertBase(db, actorId, {
        name: `Incremental ${engine}`,
      });
      const {
        tableIds: [tableId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId: base.id,
        tables: [{ schema, name: "watched" }],
      });
      const text = (value: string) =>
        engine === "sqlserver" ? `N'${value}'` : `'${value}'`;
      // SQL Server's fixture has no trigger: the application moves it.
      const touch =
        engine === "sqlserver" ? ", changed = sysutcdatetime()" : "";
      await outside(
        engine,
        `insert into watched (id, label) values (40, ${text("p")})`,
      );
      // A column that does not tell changes is refused, as for a watch.
      trace.push(
        await failure(
          setTableSync(db, actorId, {
            tableId,
            intervalMinutes: 15,
            syncMode: "incremental",
            changeColumn: "label",
          }),
        ),
      );
      await setTableSync(db, actorId, {
        tableId,
        intervalMinutes: 15,
        syncMode: "incremental",
        changeColumn: "changed",
        fullEvery: 2,
      });
      // The first refresh copies the table whole and takes its mark.
      trace.push(await runSync(syncDeps, tableId));
      const copy = async () => {
        const { engine: catalog } = await loadEngine(db, tableId, () => true);
        const label = columnOf(catalog, "label");
        const page = await readPage(
          db,
          catalog,
          { rowIds: ["40", "41"], limit: 2, timeZone: "UTC" },
          { total: false },
        );
        return page.rows
          .map((row): [string, unknown] => [row.id, row[label]])
          .sort((left, right) => left[0].localeCompare(right[0]));
      };
      trace.push(await copy());
      await outside(
        engine,
        `update watched set label = ${text("q")}${touch} where id = 40`,
      );
      await outside(
        engine,
        `insert into watched (id, label) values (41, ${text("r")})`,
      );
      // An incremental pass reads the rows past the mark, live.
      trace.push(await runSync(syncDeps, tableId), await copy());
      const state = async () =>
        db
          .selectFrom("externalSyncs")
          .select(["changes", "refreshCount", "errorCode"])
          .where("tableId", "=", tableId)
          .executeTakeFirstOrThrow();
      trace.push(await state());
      // A delete is not seen by a pass; the full copy every 2 finds it.
      await outside(engine, "delete from watched where id = 40");
      trace.push(await runSync(syncDeps, tableId), await copy());
      trace.push(await runSync(syncDeps, tableId), await copy(), await state());
      await outside(engine, "delete from watched where id = 41");
      await setTableSync(db, actorId, { tableId, intervalMinutes: null });
      traces.set(engine, trace);
    }
    const reference = traces.get("postgres");
    expect(reference).toEqual([
      "source_watch_column",
      900,
      [["40", "p"]],
      900,
      [
        ["40", "q"],
        ["41", "r"],
      ],
      { changes: 2, refreshCount: 1, errorCode: null },
      900,
      [
        ["40", "q"],
        ["41", "r"],
      ],
      900,
      [["41", "r"]],
      { changes: 1, refreshCount: 0, errorCode: null },
    ]);
    for (const engine of ["mysql", "mariadb", "sqlserver", "oracle"] as const) {
      expect(asRead(engine, traces.get(engine)), engine).toEqual(
        asRead(engine, reference),
      );
    }
  }, 300_000);

  it("computes a chart's groups and series where the rows live", async () => {
    const deps = { db, key, settings };
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      const base = await insertBase(db, actorId, { name: `Charts ${engine}` });
      const {
        tableIds: [casesId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId: base.id,
        tables: [{ schema, name: "cases" }],
      });
      const { engine: catalog } = await loadEngine(db, casesId, () => true);
      const field = (physical: string) => columnOf(catalog, physical);
      const chart = async (
        groups: string[],
        column: string,
        fn: "sum" | "count_all" | "avg" | "max",
      ) => {
        const rows = await readTransaction(db, catalog, (run) =>
          run(
            buildGroupAggregates(
              catalog,
              { timeZone: "UTC" },
              { groups, item: { column, fn } },
            ),
          ),
        );
        return chartSeries(
          catalog.table.columns,
          { groupBy: groups[0] ?? "", seriesBy: groups[1], fn },
          rows.map((row) => ({
            key: row.k0,
            series: groups.length > 1 ? row.k1 : undefined,
            value: row.a0,
          })),
        );
      };
      traces.set(engine, [
        await chart([field("b")], field("n"), "sum"),
        await chart([field("b"), field("t")], field("n"), "sum"),
        await chart([field("d")], field("id"), "count_all"),
        await chart([field("t")], field("m"), "avg"),
        await chart([field("b")], field("i"), "max"),
      ]);
    }
    const reference = traces.get("postgres");
    // The reference, written out: n sums by checkbox, then by checkbox and t.
    expect(reference?.[0]).toEqual({
      categories: ["(vide)", "false", "true"],
      series: [{ name: "", values: [1000000.1, null, 7.25] }],
      omitted: { categories: 0, series: 0 },
    });
    expect(reference?.[1]).toMatchObject({
      categories: ["(vide)", "false", "true"],
    });
    for (const engine of ["mysql", "mariadb", "sqlserver", "oracle"] as const) {
      expect(asRead(engine, traces.get(engine)), engine).toEqual(
        asRead(engine, reference),
      );
    }
  }, 300_000);

  it("imports a file into a client's table, naming the lines it refuses", async () => {
    const deps = { db, key, settings };
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      const base = await insertBase(db, actorId, { name: `Import ${engine}` });
      const {
        tableIds: [ledgerId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId: base.id,
        tables: [
          { schema, name: "ledger" },
          { schema, name: "teams" },
        ],
      });
      await setTableWrites(deps, actorId, {
        tableId: ledgerId,
        update: true,
        insert: true,
        delete: false,
      });
      const table = await db
        .selectFrom("dataTables")
        .selectAll()
        .where("id", "=", ledgerId)
        .executeTakeFirstOrThrow();
      const { engine: catalog } = await loadEngine(db, ledgerId, () => true);
      const field = (physical: string) => columnOf(catalog, physical);
      const stamp = engine.slice(0, 2);
      const mapping = ["label", "amount", "qty", "team"].map(
        (physical, source) => ({ source, column: field(physical) }),
      );
      const run = (rows: string[][], upsertSource?: number) =>
        importIntoTable(db, {
          userId: actorId,
          table,
          source: rowsSource(["label", "amount", "qty", "team"], rows),
          mapping,
          ...(upsertSource === undefined ? {} : { upsertSource }),
          addOptions: false,
          canManage: true,
          eventKey: `import:${engine}`,
        });
      const first = await run([
        [`${stamp}-A`, "1.50", "1", "1"],
        [`${stamp}-B`, "2", "2", "9"],
        [`${stamp}-C`, "x", "3", "1"],
        [`${stamp}-D`, "4", "", "2"],
      ]);
      // A line again, without a key to update by: the client's unique
      // label refuses it; the rest of the file is written.
      const second = await run([
        [`${stamp}-A`, "5", "5", "1"],
        [`${stamp}-E`, "6", "6", "1"],
      ]);
      // By key: the label finds its row.
      const third = await run([[`${stamp}-A`, "9.99", "7", "3"]], 0);
      const shape = (result: typeof first) => ({
        inserted: result.inserted,
        updated: result.updated,
        failed: result.failed,
        errors: result.errors.map((error) => [
          error.line,
          error.message,
          error.code ?? null,
        ]),
      });
      const rows = await readPage(
        db,
        catalog,
        {
          filter: {
            conjunction: "and",
            conditions: [
              { column: field("label"), op: "starts_with", value: stamp },
            ],
          },
          sort: [{ column: field("label"), direction: "asc" }],
          limit: 20,
          timeZone: "UTC",
        },
        { total: false },
      );
      traces.set(engine, [
        shape(first),
        shape(second),
        shape(third),
        rows.rows.map((row) => [
          row[field("label")],
          row[field("amount")],
          row[field("qty")],
          (row[field("team")] as Array<{ id: string }>)[0]?.id ?? null,
        ]),
      ]);
    }
    const reference = traces.get("postgres");
    expect(reference).toEqual([
      {
        inserted: 2,
        updated: 0,
        failed: 2,
        errors: [
          [4, "Invalid value", null],
          [3, "Refused", "source_value_reference"],
        ],
      },
      {
        inserted: 1,
        updated: 0,
        failed: 1,
        errors: [[2, "Refused", "source_value_duplicate"]],
      },
      { inserted: 0, updated: 1, failed: 0, errors: [] },
      [
        ["po-A", "9.99", "7", "3"],
        ["po-D", "4.00", null, "2"],
        ["po-E", "6.00", "6", "1"],
      ],
    ]);
    for (const engine of ["mysql", "mariadb", "sqlserver", "oracle"] as const) {
      const trace = traces.get(engine);
      expect(trace?.slice(0, 3), engine).toEqual(reference?.slice(0, 3));
      expect(
        asRead(
          engine,
          (trace?.[3] as unknown[][]).map((row) => row.slice(1)),
        ),
        engine,
      ).toEqual(
        asRead(
          engine,
          (reference?.[3] as unknown[][]).map((row) => row.slice(1)),
        ),
      );
    }
  }, 300_000);

  it("puts rows deleted through AnyGridDB back from the trash", async () => {
    const deps = { db, key, settings };
    const services = { db, bus: recordingBus().bus, log: () => undefined };
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      const base = await insertBase(db, actorId, { name: `Trash ${engine}` });
      const {
        tableIds: [ledgerId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId: base.id,
        tables: [
          { schema, name: "ledger" },
          { schema, name: "teams" },
        ],
      });
      await setTableWrites(deps, actorId, {
        tableId: ledgerId,
        update: true,
        insert: true,
        delete: true,
      });
      const table = await db
        .selectFrom("dataTables")
        .selectAll()
        .where("id", "=", ledgerId)
        .executeTakeFirstOrThrow();
      const scope = await loadRowScope(
        db,
        {
          userId: actorId,
          bindings: [{ role: "owner", scope: "base", scopeId: base.id }],
        },
        table,
      );
      const field = (physical: string) => columnOf(scope.engine, physical);
      const label = `trash-${engine.slice(0, 2)}`;
      const [id = ""] = await createRows(
        services,
        scope,
        [
          {
            values: {
              [field("label")]: label,
              [field("amount")]: "12.30",
              [field("team")]: "2",
            },
          },
        ],
        { source: "web" },
      );
      await deleteRows(services, scope, [id], { source: "web" });
      const before = await listExternalTrash(db, scope.engine, 50);
      const [restored = ""] = await restoreRows(services, scope, [id], {
        source: "restore",
      });
      const after = await listExternalTrash(db, scope.engine, 50);
      const back = await readPage(
        db,
        scope.engine,
        {
          rowIds: [restored],
          fields: [field("label"), field("amount"), field("team")],
          limit: 1,
          timeZone: "UTC",
        },
        { total: false },
      );
      const row: Record<string, unknown> = back.rows[0] ?? {};
      traces.set(engine, [
        before.some((item) => item.rowId === id && item.label === label),
        after.some((item) => item.rowId === id),
        row[field("label")],
        row[field("amount")],
        (row[field("team")] as Array<{ id: string }> | undefined)?.[0]?.id,
        // PostgreSQL and MySQL take the old key back; SQL Server's
        // identity gives a new one, and the row still leaves the trash.
        engine === "sqlserver" ? restored !== "" : restored === id,
      ]);
    }
    for (const engine of [
      "postgres",
      "mysql",
      "mariadb",
      "sqlserver",
      "oracle",
    ] as const) {
      expect(traces.get(engine), engine).toEqual([
        true,
        false,
        `trash-${engine.slice(0, 2)}`,
        asRead(engine, "12.30"),
        "2",
        true,
      ]);
    }
  }, 300_000);

  it("links rows from the other end, writing their foreign key", async () => {
    const deps = { db, key, settings };
    const services = { db, bus: recordingBus().bus, log: () => undefined };
    const traces = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      const base = await insertBase(db, actorId, { name: `Links ${engine}` });
      const {
        tableIds: [ledgerId = "", teamsId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId: base.id,
        tables: [
          { schema, name: "ledger" },
          { schema, name: "teams" },
        ],
      });
      const bindings = [
        { role: "owner" as const, scope: "base" as const, scopeId: base.id },
      ];
      const scopeOf = async (tableId: string) =>
        loadRowScope(
          db,
          { userId: actorId, bindings },
          await db
            .selectFrom("dataTables")
            .selectAll()
            .where("id", "=", tableId)
            .executeTakeFirstOrThrow(),
        );
      const failure = (promise: Promise<unknown>) =>
        promise.then(
          () => "ok",
          (error: unknown) =>
            error instanceof AppError ? error.code : String(error),
        );
      let ledger = await scopeOf(ledgerId);
      const teams = await scopeOf(teamsId);
      const field = (physical: string) => columnOf(ledger.engine, physical);
      const inverse = teams.engine.table.columns.find(
        (column) => column.relation?.direction === "inverse",
      )?.name;
      // The other table takes no writes yet: the link is refused.
      await setTableWrites(deps, actorId, {
        tableId: ledgerId,
        update: false,
        insert: true,
        delete: false,
      });
      ledger = await scopeOf(ledgerId);
      const label = `link-${engine.slice(0, 2)}`;
      const ids = await createRows(
        services,
        ledger,
        [1, 2].map((n) => ({
          values: {
            [field("label")]: `${label}-${String(n)}`,
            [field("team")]: "1",
          },
        })),
        { source: "web" },
      );
      const link = (targetIds: string[]) =>
        failure(
          replaceLinks(
            services,
            teams,
            "3",
            { column: inverse ?? "", targetIds },
            { source: "web" },
          ),
        );
      const refused = await link(ids);
      await setTableWrites(deps, actorId, {
        tableId: ledgerId,
        update: true,
        insert: true,
        delete: false,
      });
      const linked = await link(ids);
      const teamOf = async () =>
        (
          await readPage(
            db,
            ledger.engine,
            {
              rowIds: ids,
              fields: [field("label"), field("team")],
              sort: [{ column: field("label"), direction: "asc" }],
              limit: 5,
              timeZone: "UTC",
            },
            { total: false },
          )
        ).rows.map(
          (row) => (row[field("team")] as Array<{ id: string }>)[0]?.id ?? null,
        );
      const afterLink = await teamOf();
      // Unlinking the second row clears its key.
      const unlinked = await link(ids.slice(0, 1));
      traces.set(engine, [
        refused,
        linked,
        afterLink,
        unlinked,
        await teamOf(),
      ]);
    }
    for (const engine of [
      "postgres",
      "mysql",
      "mariadb",
      "sqlserver",
      "oracle",
    ] as const) {
      expect(traces.get(engine), engine).toEqual([
        "external_table_read_only",
        "ok",
        ["3", "3"],
        "ok",
        ["3", null],
      ]);
    }
  }, 300_000);

  it("says where each group starts, its rows together, where the rows live", async () => {
    const deps = { db, key, settings };
    const tops = new Map<Engine, unknown[]>();
    for (const [engine, { sourceId, schema }] of declared) {
      // "Ops" sorts with "ops" under a collation blind to case, but groups
      // apart from it wherever keys compare as bytes or as JSON: the rows
      // of each must still follow each other.
      await outside(
        engine,
        engine === "sqlserver"
          ? "insert into staff values (6, N'Fay', N'Ops', 600.00)"
          : "insert into staff values (6, 'Fay', 'Ops', 600.00)",
      );
      const base = await insertBase(db, actorId, { name: `Grouped ${engine}` });
      const {
        tableIds: [staffId = ""],
      } = await exposeTables(deps, actorId, {
        sourceId,
        baseId: base.id,
        tables: [{ schema, name: "staff" }],
      });
      const { engine: catalog } = await loadEngine(db, staffId, () => true);
      const levels = [columnOf(catalog, "dept"), columnOf(catalog, "name")];
      const page = await readPage(
        db,
        catalog,
        {
          limit: 100,
          timeZone: "UTC",
          groupBy: levels.map((column) => ({ column, direction: "asc" })),
        },
        { total: false, groups: "starts" },
      );
      await outside(engine, "delete from staff where id = 6");
      const folded = (value: unknown) => String(value).toLowerCase();
      expect(page.groups.length, engine).toBeGreaterThan(0);
      for (const group of page.groups) {
        expect(group.start, engine).toBeTypeOf("number");
        const start = group.start ?? 0;
        const under = page.rows.slice(start, start + group.count);
        expect(under, engine).toHaveLength(group.count);
        for (const row of under) {
          group.keys.slice(0, group.depth).forEach((value, depth) => {
            expect(folded(row[levels[depth] ?? ""]), engine).toBe(
              folded(value),
            );
          });
        }
      }
      const top = page.groups.filter((group) => group.depth === 1);
      expect(
        top.reduce((sum, group) => sum + group.count, 0),
        engine,
      ).toBe(page.rows.length);
      tops.set(
        engine,
        top.map((group) => group.keys[0]),
      );
    }
    for (const engine of ["postgres", "mysql", "oracle"] as const) {
      expect(tops.get(engine), engine).toEqual(
        expect.arrayContaining(["Ops", "ops"]),
      );
    }
  }, 300_000);
});
