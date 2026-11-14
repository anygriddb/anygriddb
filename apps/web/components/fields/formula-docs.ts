/**
 * What each formula function does, for the formula editor's help and its
 * completion: its arguments, one sentence, and an example to try. Typed by
 * core's function list, so a function added there without its help here
 * does not compile. Arguments are named in the reader's language; the
 * examples read fields named as the editor's hint names them.
 */
import type { FormulaFn } from "@anygriddb/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

const FORMULA_GROUPS = [
  "number",
  "text",
  "logic",
  "date",
  "list",
  "row",
] as const;

type FormulaGroup = (typeof FORMULA_GROUPS)[number];

export const FORMULA_GROUP_LABELS: Record<FormulaGroup, MessageDescriptor> = {
  number: msg`Numbers`,
  text: msg`Text`,
  logic: msg`Logic`,
  date: msg`Dates`,
  list: msg`Lists`,
  row: msg`Row`,
};

type FormulaDoc = {
  group: FormulaGroup;
  /** What follows the name: its arguments, in parentheses. */
  args: MessageDescriptor;
  /** What it gives, in one short sentence. */
  summary: MessageDescriptor;
  /** A formula to try. */
  example: string;
};

const NONE = msg`()`;
const NUMBER = msg`(number)`;
const NUMBERS = msg`(number, …)`;
const ROUNDING = msg`(number, [decimals])`;
const TEXT = msg`(text)`;
const TEXT_COUNT = msg`(text, count)`;
const VALUE = msg`(value)`;
const CONDITIONS = msg`(condition, …)`;
const DATE = msg`(date)`;
const TWO_DATES = msg`(date1, date2)`;
const SEARCHED = msg`(sought, text, [start])`;
const DELIMITED = msg`(text, delimiter)`;
const PATTERN = msg`(text, "pattern")`;
const LIST = msg`(list)`;
const FROM_NOW = msg`(date, ["unit"])`;
const WORKDAYS = msg`(start, end, ["holidays"])`;

export const FORMULA_DOCS: Record<FormulaFn, FormulaDoc> = {
  sum: {
    group: "number",
    args: NUMBERS,
    summary: msg`Adds up the numbers and lists of numbers.`,
    example: "SUM({Price}, {Fees})",
  },
  average: {
    group: "number",
    args: NUMBERS,
    summary: msg`The mean of the numbers given.`,
    example: "AVERAGE({Price}, {Fees})",
  },
  min: {
    group: "number",
    args: msg`(value, …)`,
    summary: msg`The smallest value, number or date.`,
    example: "MIN({Price}, 100)",
  },
  max: {
    group: "number",
    args: msg`(value, …)`,
    summary: msg`The largest value, number or date.`,
    example: "MAX({Price}, 0)",
  },
  round: {
    group: "number",
    args: ROUNDING,
    summary: msg`Rounds to the nearest, with no decimals by default.`,
    example: "ROUND({Price} * 1.2, 2)",
  },
  roundup: {
    group: "number",
    args: ROUNDING,
    summary: msg`Rounds away from zero.`,
    example: "ROUNDUP({Price}, 0)",
  },
  rounddown: {
    group: "number",
    args: ROUNDING,
    summary: msg`Rounds toward zero, cutting the decimals.`,
    example: "ROUNDDOWN({Price}, 1)",
  },
  int: {
    group: "number",
    args: NUMBER,
    summary: msg`The whole number just below: INT(-1.5) is -2.`,
    example: "INT({Price})",
  },
  floor: {
    group: "number",
    args: NUMBER,
    summary: msg`The whole number just below, as INT gives.`,
    example: "FLOOR({Price})",
  },
  ceil: {
    group: "number",
    args: NUMBER,
    summary: msg`The whole number just above.`,
    example: "CEIL({Price})",
  },
  abs: {
    group: "number",
    args: NUMBER,
    summary: msg`The number without its sign.`,
    example: "ABS({Price} - {Fees})",
  },
  mod: {
    group: "number",
    args: msg`(number, divisor)`,
    summary: msg`The remainder of the division.`,
    example: "MOD({Quantity}, 12)",
  },
  power: {
    group: "number",
    args: msg`(base, exponent)`,
    summary: msg`The base raised to the given power.`,
    example: "POWER({Quantity}, 2)",
  },
  sqrt: {
    group: "number",
    args: NUMBER,
    summary: msg`Square root; blank for a negative number.`,
    example: "SQRT({Quantity})",
  },
  exp: {
    group: "number",
    args: NUMBER,
    summary: msg`Exponential: e to the power of the number.`,
    example: "EXP({Quantity})",
  },
  ln: {
    group: "number",
    args: NUMBER,
    summary: msg`Natural logarithm; blank for 0 or less.`,
    example: "LN({Quantity})",
  },
  log: {
    group: "number",
    args: msg`(number, [base])`,
    summary: msg`Logarithm, in base 10 by default.`,
    example: "LOG({Quantity}, 2)",
  },
  sign: {
    group: "number",
    args: NUMBER,
    summary: msg`-1, 0, or 1, by its sign.`,
    example: "SIGN({Price} - {Fees})",
  },
  even: {
    group: "number",
    args: NUMBER,
    summary: msg`The next even number, away from zero.`,
    example: "EVEN({Quantity})",
  },
  odd: {
    group: "number",
    args: NUMBER,
    summary: msg`The next odd number, away from zero.`,
    example: "ODD({Quantity})",
  },
  value: {
    group: "number",
    args: TEXT,
    summary: msg`Reads text as a number.`,
    example: "VALUE({Code})",
  },

  concat: {
    group: "text",
    args: msg`(text, …)`,
    summary: msg`Joins texts end to end, as the & operator does.`,
    example: 'CONCAT({First name}, " ", {Name})',
  },
  left: {
    group: "text",
    args: TEXT_COUNT,
    summary: msg`The first characters.`,
    example: "LEFT({Code}, 3)",
  },
  right: {
    group: "text",
    args: TEXT_COUNT,
    summary: msg`The last characters.`,
    example: "RIGHT({Code}, 2)",
  },
  mid: {
    group: "text",
    args: msg`(text, start, [count])`,
    summary: msg`The characters from a position, 1 for the first.`,
    example: "MID({Code}, 2, 3)",
  },
  len: {
    group: "text",
    args: TEXT,
    summary: msg`The number of characters.`,
    example: "LEN({Name})",
  },
  lower: {
    group: "text",
    args: TEXT,
    summary: msg`The text in lower case.`,
    example: "LOWER({Email})",
  },
  upper: {
    group: "text",
    args: TEXT,
    summary: msg`The text in upper case.`,
    example: "UPPER({Name})",
  },
  trim: {
    group: "text",
    args: TEXT,
    summary: msg`The text without leading and trailing spaces.`,
    example: "TRIM({Name})",
  },
  substitute: {
    group: "text",
    args: msg`(text, old, new)`,
    summary: msg`Replaces every occurrence of a text with another.`,
    example: 'SUBSTITUTE({Phone}, " ", "")',
  },
  replace: {
    group: "text",
    args: msg`(text, start, count, new)`,
    summary: msg`Replaces characters from a position.`,
    example: 'REPLACE({Code}, 1, 2, "FR")',
  },
  find: {
    group: "text",
    args: SEARCHED,
    summary: msg`Where the sought text starts, case included; 0 when it is not there.`,
    example: 'FIND("@", {Email})',
  },
  search: {
    group: "text",
    args: SEARCHED,
    summary: msg`Like FIND, ignoring upper and lower case.`,
    example: 'SEARCH("sas", {Name})',
  },
  rept: {
    group: "text",
    args: msg`(text, times)`,
    summary: msg`Repeats a text, up to 10,000 characters.`,
    example: 'REPT("★", {Quantity})',
  },
  t: {
    group: "text",
    args: VALUE,
    summary: msg`The value when it is text, otherwise empty text.`,
    example: "T({Name})",
  },
  text_before: {
    group: "text",
    args: DELIMITED,
    summary: msg`What comes before the first delimiter; blank when it is not there.`,
    example: 'TEXT_BEFORE({Email}, "@")',
  },
  text_after: {
    group: "text",
    args: DELIMITED,
    summary: msg`What comes after the first delimiter; blank when it is not there.`,
    example: 'TEXT_AFTER({Email}, "@")',
  },
  text_split: {
    group: "text",
    args: msg`(text, separator)`,
    summary: msg`Splits the text into a list.`,
    example: 'TEXT_SPLIT({Notes}, ",")',
  },
  encode_url_component: {
    group: "text",
    args: TEXT,
    summary: msg`Encodes the text to put it in a web address.`,
    example: '"https://example.com/?q=" & ENCODE_URL_COMPONENT({Name})',
  },
  json_extract: {
    group: "text",
    args: msg`(json, "path")`,
    summary: msg`A JSON document's value at a path, such as $.client.name or $.lines[0].`,
    example: 'JSON_EXTRACT({Notes}, "$.client.name")',
  },
  regex_match: {
    group: "text",
    args: PATTERN,
    summary: msg`True when the text matches the regular expression.`,
    example: 'REGEX_MATCH({Code}, "^[A-Z]+-[0-9]+$")',
  },
  regex_extract: {
    group: "text",
    args: PATTERN,
    summary: msg`The first part of the text that matches the regular expression.`,
    example: 'REGEX_EXTRACT({Notes}, "[0-9]+")',
  },
  regex_replace: {
    group: "text",
    args: msg`(text, "pattern", replacement)`,
    summary: msg`Replaces every part that matches the regular expression.`,
    example: 'REGEX_REPLACE({Phone}, "[^0-9]", "")',
  },
  md5: {
    group: "text",
    args: TEXT,
    summary: msg`The text's MD5 digest, in hexadecimal.`,
    example: "MD5({Email})",
  },
  sha256: {
    group: "text",
    args: TEXT,
    summary: msg`The text's SHA-256 digest, in hexadecimal.`,
    example: "SHA256({Email})",
  },
  sha512: {
    group: "text",
    args: TEXT,
    summary: msg`The text's SHA-512 digest, in hexadecimal.`,
    example: "SHA512({Email})",
  },

  if: {
    group: "logic",
    args: msg`(condition, then, [else])`,
    summary: msg`One value or the other, by the condition.`,
    example: 'IF({Paid}, "Settled", "Follow up")',
  },
  switch: {
    group: "logic",
    args: msg`(value, case, result, …, [default])`,
    summary: msg`The result of the first case equal to the value.`,
    example: 'SWITCH({Status}, "Open", 1, "Closed", 2, 0)',
  },
  and: {
    group: "logic",
    args: CONDITIONS,
    summary: msg`True when every condition is.`,
    example: "AND({Paid}, {Delivered})",
  },
  or: {
    group: "logic",
    args: CONDITIONS,
    summary: msg`True when at least one condition is.`,
    example: "OR({Paid}, {Delivered})",
  },
  xor: {
    group: "logic",
    args: CONDITIONS,
    summary: msg`True when an odd number of conditions are.`,
    example: "XOR({Paid}, {Delivered})",
  },
  not: {
    group: "logic",
    args: msg`(condition)`,
    summary: msg`The opposite of the condition.`,
    example: "NOT({Paid})",
  },
  true: {
    group: "logic",
    args: NONE,
    summary: msg`The true value.`,
    example: "TRUE()",
  },
  false: {
    group: "logic",
    args: NONE,
    summary: msg`The false value.`,
    example: "FALSE()",
  },
  blank: {
    group: "logic",
    args: NONE,
    summary: msg`A blank value.`,
    example: "IF({Quantity} > 0, {Price}, BLANK())",
  },
  is_blank: {
    group: "logic",
    args: VALUE,
    summary: msg`True when the value is blank: nothing, empty text, or an empty list.`,
    example: "IS_BLANK({Email})",
  },
  is_not_blank: {
    group: "logic",
    args: VALUE,
    summary: msg`True when the value is filled.`,
    example: "IS_NOT_BLANK({Email})",
  },
  error: {
    group: "logic",
    args: msg`([message])`,
    summary: msg`An error, shown in the cell with its message.`,
    example: 'IF({Quantity} < 0, ERROR("Negative quantity"), {Quantity})',
  },
  is_error: {
    group: "logic",
    args: VALUE,
    summary: msg`True when the value is an error.`,
    example: "IS_ERROR({Price} / {Quantity})",
  },

  today: {
    group: "date",
    args: NONE,
    summary: msg`Today's date, in the reader's time zone.`,
    example: "TODAY()",
  },
  now: {
    group: "date",
    args: NONE,
    summary: msg`The date and time now.`,
    example: "NOW()",
  },
  date_add: {
    group: "date",
    args: msg`(date, number, "unit")`,
    summary: msg`Adds a duration in years, months, weeks, days, hours, minutes, or seconds.`,
    example: 'DATE_ADD({Start}, 30, "days")',
  },
  datetime_diff: {
    group: "date",
    args: msg`(date1, date2, ["unit"])`,
    summary: msg`date1 minus date2, in days by default; negative when date1 comes first.`,
    example: 'DATETIME_DIFF({End}, {Start}, "days")',
  },
  datetime_format: {
    group: "date",
    args: msg`(date, "format")`,
    summary: msg`The date as text, with YYYY, MM, DD, HH, mm, dddd, MMMM…`,
    example: 'DATETIME_FORMAT({Start}, "DD/MM/YYYY")',
  },
  datetime_parse: {
    group: "date",
    args: msg`(text, ["format"])`,
    summary: msg`Reads text as a date, in the given format (YYYY, MM, DD, HH, mm, ss).`,
    example: 'DATETIME_PARSE({Code}, "DD/MM/YYYY")',
  },
  datestr: {
    group: "date",
    args: DATE,
    summary: msg`The date as text, such as 2026-11-08.`,
    example: "DATESTR({Start})",
  },
  year: {
    group: "date",
    args: DATE,
    summary: msg`The year.`,
    example: "YEAR({Start})",
  },
  month: {
    group: "date",
    args: DATE,
    summary: msg`The month, from 1 to 12.`,
    example: "MONTH({Start})",
  },
  day: {
    group: "date",
    args: DATE,
    summary: msg`The day of the month.`,
    example: "DAY({Start})",
  },
  hour: {
    group: "date",
    args: DATE,
    summary: msg`The hour, from 0 to 23.`,
    example: "HOUR({Start})",
  },
  minute: {
    group: "date",
    args: DATE,
    summary: msg`The minutes.`,
    example: "MINUTE({Start})",
  },
  second: {
    group: "date",
    args: DATE,
    summary: msg`The seconds.`,
    example: "SECOND({Start})",
  },
  weekday: {
    group: "date",
    args: DATE,
    summary: msg`The day of the week, from 0 (Sunday) to 6 (Saturday).`,
    example: "WEEKDAY({Start})",
  },
  weeknum: {
    group: "date",
    args: DATE,
    summary: msg`The ISO week number.`,
    example: "WEEKNUM({Start})",
  },
  is_before: {
    group: "date",
    args: TWO_DATES,
    summary: msg`True when date1 comes before date2.`,
    example: "IS_BEFORE({End}, TODAY())",
  },
  is_after: {
    group: "date",
    args: TWO_DATES,
    summary: msg`True when date1 comes after date2.`,
    example: "IS_AFTER({End}, {Start})",
  },
  is_same: {
    group: "date",
    args: msg`(date1, date2, ["unit"])`,
    summary: msg`True when both dates fall on the same day, or in the same unit.`,
    example: 'IS_SAME({Start}, TODAY(), "month")',
  },
  workday: {
    group: "date",
    args: msg`(start, days, ["holidays"])`,
    summary: msg`The date after this many working days, Monday to Friday, skipping holidays.`,
    example: 'WORKDAY({Start}, 10, "2026-12-25, 2027-01-01")',
  },
  workday_diff: {
    group: "date",
    args: WORKDAYS,
    summary: msg`The working days between two dates, both counted.`,
    example: "WORKDAY_DIFF({Start}, {End})",
  },
  fromnow: {
    group: "date",
    args: FROM_NOW,
    summary: msg`The time between now and the date, in days by default.`,
    example: 'FROMNOW({Start}, "days")',
  },
  tonow: {
    group: "date",
    args: FROM_NOW,
    summary: msg`The time between the date and now, as FROMNOW gives.`,
    example: 'TONOW({End}, "hours")',
  },

  array_join: {
    group: "list",
    args: msg`(list, [separator])`,
    summary: msg`The list's values as one text, separated by a comma by default.`,
    example: 'ARRAY_JOIN({Tags}, " · ")',
  },
  array_unique: {
    group: "list",
    args: LIST,
    summary: msg`The list without its duplicates.`,
    example: "ARRAY_UNIQUE({Tags})",
  },
  array_compact: {
    group: "list",
    args: LIST,
    summary: msg`The list without its blank values.`,
    example: "ARRAY_COMPACT({Tags})",
  },
  array_sort: {
    group: "list",
    args: msg`(list, ["asc" or "desc"])`,
    summary: msg`The list sorted, blanks last.`,
    example: 'ARRAY_SORT({Tags}, "desc")',
  },
  array_slice: {
    group: "list",
    args: msg`(list, from, [to])`,
    summary: msg`Part of the list, counted from 1; -1 is the last value.`,
    example: "ARRAY_SLICE({Tags}, 1, 3)",
  },
  array_flatten: {
    group: "list",
    args: msg`(list, …)`,
    summary: msg`The values of every list, one after the other.`,
    example: "ARRAY_FLATTEN({Tags}, {Notes})",
  },
  count: {
    group: "list",
    args: msg`(value, …)`,
    summary: msg`How many values are numbers.`,
    example: "COUNT({Price}, {Fees})",
  },
  counta: {
    group: "list",
    args: msg`(value, …)`,
    summary: msg`How many values are filled.`,
    example: "COUNTA({Tags})",
  },
  countall: {
    group: "list",
    args: msg`(value, …)`,
    summary: msg`How many values in all, blanks included.`,
    example: "COUNTALL({Tags})",
  },

  record_id: {
    group: "row",
    args: NONE,
    summary: msg`The row's id.`,
    example: "RECORD_ID()",
  },
  autonumber: {
    group: "row",
    args: NONE,
    summary: msg`The row's number, given when it was created.`,
    example: "AUTONUMBER()",
  },
  created_time: {
    group: "row",
    args: NONE,
    summary: msg`When the row was created.`,
    example: "CREATED_TIME()",
  },
  last_modified_time: {
    group: "row",
    args: NONE,
    summary: msg`When the row was last changed.`,
    example: "LAST_MODIFIED_TIME()",
  },
};

/** The functions of each group, in the order above. */
export function formulaGroups(): Array<{
  group: FormulaGroup;
  fns: FormulaFn[];
}> {
  const entries = Object.entries(FORMULA_DOCS) as Array<
    [FormulaFn, FormulaDoc]
  >;
  return FORMULA_GROUPS.map((group) => ({
    group,
    fns: entries.filter(([, doc]) => doc.group === group).map(([fn]) => fn),
  }));
}
