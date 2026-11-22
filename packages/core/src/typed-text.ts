/**
 * What a person or a file wrote, read as a number, a day, or an instant.
 * Each reader answers the one value the text says, or nothing: a text
 * that could say two things is not settled by guessing.
 */
import { toDecimalString } from "./decimal";
import { isIsoDate, isIsoDateTime, utcMillis } from "./iso-date";

/** What separates a number's decimals where the text was written. */
export type DecimalMark = "." | ",";

/** Which comes first in a day written with numbers. */
export type DayOrder = "day-first" | "month-first";

const GROUPS_BY_COMMA = /^\d{1,3}(?:,\d{3})+$/;
const GROUPS_BY_POINT = /^\d{1,3}(?:\.\d{3})+$/;
const GROUPS_BY_SPACE = /^\d{1,3}(?: \d{3})+$/;
/** `1.234`: where a comma is the decimal mark, this point groups thousands. */
const ONE_GROUP_BY_POINT = /^[1-9]\d{0,2}\.\d{3}$/;
const DIGITS = /^\d+$/;

/** Whole digits and decimals as a plain decimal; nothing if either is not. */
function joined(whole: string, decimals: string): string | undefined {
  return DIGITS.test(whole) && DIGITS.test(decimals)
    ? `${whole}.${decimals}`
    : undefined;
}

/** A number holding a single comma and nothing else that separates. */
function oneComma(
  body: string,
  comma: number,
  mark: DecimalMark | undefined,
): string | undefined {
  const whole = body.slice(0, comma);
  const after = body.slice(comma + 1);
  // Three digits after one to three, the first not a zero: `1,234` is a
  // thousand and more in English, a little over one in French.
  const twoReadings =
    after.length === 3 && whole.length <= 3 && !whole.startsWith("0");
  if (!twoReadings || mark === ",") return joined(whole, after);
  if (mark === undefined || !DIGITS.test(whole) || !DIGITS.test(after)) {
    return undefined;
  }
  return `${whole}${after}`;
}

/** The body of a number, once its separators are read, as plain digits. */
function plainBody(
  body: string,
  mark: DecimalMark | undefined,
): string | undefined {
  const comma = body.lastIndexOf(",");
  const point = body.lastIndexOf(".");
  if (body.includes(" ")) {
    const at = Math.max(comma, point);
    const whole = at === -1 ? body : body.slice(0, at);
    if (!GROUPS_BY_SPACE.test(whole)) return undefined;
    const digits = whole.replace(/ /g, "");
    return at === -1 ? digits : joined(digits, body.slice(at + 1));
  }
  if (comma === -1) {
    return mark === "," && ONE_GROUP_BY_POINT.test(body) ? undefined : body;
  }
  if (point !== -1) {
    const whole = body.slice(0, Math.max(comma, point));
    const grouped = comma > point ? GROUPS_BY_POINT : GROUPS_BY_COMMA;
    if (!grouped.test(whole)) return undefined;
    return joined(
      whole.replace(/[.,]/g, ""),
      body.slice(Math.max(comma, point) + 1),
    );
  }
  if (body.indexOf(",") !== comma) {
    return GROUPS_BY_COMMA.test(body) ? body.replace(/,/g, "") : undefined;
  }
  return oneComma(body, comma, mark);
}

/** A number's text without its currency sign, its sign set apart. */
function signedBody(raw: string): { sign: string; body: string } {
  const tidy = raw
    .replace(/[€$£¥%]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  const sign = tidy.startsWith("-") ? "-" : tidy.startsWith("+") ? "+" : "";
  return { sign, body: tidy.slice(sign.length).trimStart() };
}

/**
 * The exact decimal a text writes: currency signs go, and its separators
 * are read. `1,234` alone reads two ways, and needs `mark` to say which.
 * Where the mark is a comma, `1.234` reads two ways too, and is refused.
 */
export function readNumberText(
  raw: string,
  mark?: DecimalMark,
): string | undefined {
  const { sign, body } = signedBody(raw);
  if (body === "") return undefined;
  const plain = plainBody(body, mark);
  return plain === undefined ? undefined : toDecimalString(`${sign}${plain}`);
}

/** Whether a text is a number only once its decimal mark is known. */
export function isAmbiguousNumber(text: string): boolean {
  return (
    text.includes(",") &&
    readNumberText(text) === undefined &&
    readNumberText(text, ".") !== undefined
  );
}

/** Whether a text is `1.234`, which a comma's language would read as 1234. */
export function isAmbiguousPoint(text: string): boolean {
  return text.includes(".") && ONE_GROUP_BY_POINT.test(signedBody(text).body);
}

const MONTHS = new Map<string, number>(
  (
    [
      ["january", "jan", "janvier", "janv"],
      ["february", "feb", "fevrier", "fevr", "fev"],
      ["march", "mar", "mars"],
      ["april", "apr", "avril", "avr"],
      ["may", "mai"],
      ["june", "jun", "juin"],
      ["july", "jul", "juillet", "juil"],
      ["august", "aug", "aout"],
      ["september", "sep", "sept", "septembre"],
      ["october", "oct", "octobre"],
      ["november", "nov", "novembre"],
      ["december", "dec", "decembre"],
    ] as const
  ).flatMap((names, index) =>
    names.map((name): [string, number] => [name, index + 1]),
  ),
);

function monthNamed(name: string): number | undefined {
  return MONTHS.get(name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase());
}

function isoDay(year: string, month: number, day: string): string | undefined {
  const text = `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isIsoDate(text) ? text : undefined;
}

const NUMBERS_YEAR_LAST = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/;
const NUMBERS_YEAR_FIRST = /^(\d{4})([/.])(\d{1,2})\2(\d{1,2})$/;
const NAME_THEN_DAY = /^(\p{L}+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/u;
const DAY_THEN_NAME = /^(\d{1,2})(?:st|nd|rd|th|er)? (\p{L}+)\.?,? (\d{4})$/u;

/** The two days a text in numbers can name: day first, and month first. */
function bothReadings(numbers: RegExpExecArray): {
  dayFirst: string | undefined;
  monthFirst: string | undefined;
} {
  const [, first = "", , second = "", year = ""] = numbers;
  return {
    dayFirst: isoDay(year, Number(second), first),
    monthFirst: isoDay(year, Number(first), second),
  };
}

/**
 * The day a text writes, with a year of four digits: in numbers, or with
 * the month's name in English or French. `order` is what the field or the
 * reader declares, and is followed. Without one, a text with a single
 * valid reading has that one, and `03/04/2026`, which has two, has none.
 */
export function readDayText(raw: string, order?: DayOrder): string | undefined {
  const text = raw.trim().replace(/\s+/g, " ");
  if (isIsoDate(text)) return text;
  if (isIsoDateTime(text)) return text.slice(0, 10);
  const numbers = NUMBERS_YEAR_LAST.exec(text);
  if (numbers) {
    const { dayFirst, monthFirst } = bothReadings(numbers);
    if (order === "day-first") return dayFirst;
    if (order === "month-first") return monthFirst;
    return dayFirst && monthFirst && dayFirst !== monthFirst
      ? undefined
      : (dayFirst ?? monthFirst);
  }
  const yearFirst = NUMBERS_YEAR_FIRST.exec(text);
  if (yearFirst) {
    const [, year = "", , month = "", day = ""] = yearFirst;
    return isoDay(year, Number(month), day);
  }
  const named = NAME_THEN_DAY.exec(text);
  if (named) {
    const [, name = "", day = "", year = ""] = named;
    const month = monthNamed(name);
    return month === undefined ? undefined : isoDay(year, month, day);
  }
  const dayFirst = DAY_THEN_NAME.exec(text);
  if (dayFirst) {
    const [, day = "", name = "", year = ""] = dayFirst;
    const month = monthNamed(name);
    return month === undefined ? undefined : isoDay(year, month, day);
  }
  return undefined;
}

/**
 * Whether a text starts with a day in numbers that is two valid, different
 * days, as `03/04/2026` is. A time may follow it.
 */
export function isAmbiguousDate(text: string): boolean {
  const [head = ""] = text.trim().split(/\s/, 1);
  const numbers = NUMBERS_YEAR_LAST.exec(head);
  if (!numbers) return false;
  const { dayFirst, monthFirst } = bothReadings(numbers);
  return Boolean(dayFirst && monthFirst && dayFirst !== monthFirst);
}

const DAY_MS = 86_400_000;

const ZONE_FORMATS = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let format = ZONE_FORMATS.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (ZONE_FORMATS.size >= 512) ZONE_FORMATS.clear();
    ZONE_FORMATS.set(timeZone, format);
  }
  return format;
}

/** How far ahead of UTC a zone's clocks are at an instant, in ms. */
function zoneOffset(timeZone: string, at: number): number {
  if (timeZone === "UTC") return 0;
  const parts = zoneFormat(timeZone).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const era = parts.find((part) => part.type === "era")?.value;
  const year = era === "BC" ? 1 - get("year") : get("year");
  const clock = utcMillis(
    year,
    get("month"),
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return clock - Math.floor(at / 1_000) * 1_000;
}

/**
 * The instants a zone's clocks show a wall-clock time, earliest first:
 * none when they skip it, two when they go back over it.
 */
function instantsOf(timeZone: string, wall: number): number[] {
  const offsets = new Set([
    zoneOffset(timeZone, wall - DAY_MS),
    zoneOffset(timeZone, wall + DAY_MS),
  ]);
  return [...offsets]
    .map((offset) => wall - offset)
    .filter((at) => zoneOffset(timeZone, at) === wall - at)
    .sort((a, b) => a - b);
}

function instantText(at: number, fraction: string): string | undefined {
  const text = new Date(at).toISOString();
  const written = `${text.slice(0, 19)}${fraction ? `.${fraction}` : ""}Z`;
  return isIsoDateTime(written) ? written : undefined;
}

function wallOfDay(day: string): number {
  return utcMillis(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)),
    Number(day.slice(8, 10)),
  );
}

/** When a day begins in a zone: its midnight, or the hour clocks skip to. */
function startOfDay(day: string, timeZone: string): string | undefined {
  const wall = wallOfDay(day);
  const first = instantsOf(timeZone, wall)[0];
  return instantText(first ?? wall - zoneOffset(timeZone, wall - DAY_MS), "");
}

const WRITTEN_ZONE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?) ?(Z|[+-]\d{2}(?::?\d{2})?)$/i;
const CLOCK = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,6}))?)?$/;
const MERIDIEM = / ?([ap])\.?m\.?$/i;

/** An offset as an instant writes it: `+02` and `+0200` are `+02:00`. */
function offsetText(zone: string): string {
  if (zone.toUpperCase() === "Z") return "Z";
  const digits = zone.slice(1).replace(":", "").padEnd(4, "0");
  return `${zone.slice(0, 1)}${digits.slice(0, 2)}:${digits.slice(2)}`;
}

/** Hours, minutes, seconds, and a fraction, from what a clock writes. */
function readClock(
  raw: string,
):
  | { hour: number; minute: number; second: number; fraction: string }
  | undefined {
  const meridiem = MERIDIEM.exec(raw);
  const clock = CLOCK.exec(
    (meridiem ? raw.slice(0, meridiem.index) : raw).trim(),
  );
  if (!clock) return undefined;
  let hour = Number(clock[1]);
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem[1]?.toLowerCase() === "p" ? 12 : 0);
  }
  if (hour > 23) return undefined;
  return {
    hour,
    minute: Number(clock[2]),
    second: Number(clock[3] ?? 0),
    fraction: clock[4] ?? "",
  };
}

/**
 * The instant a text writes. One that says its zone is taken as it is;
 * a day alone is midnight in `timeZone`, and a time without a zone is
 * read there. A time that zone's clocks skip does not exist.
 */
export function readInstantText(
  raw: string,
  options: { order?: DayOrder; timeZone: string },
): string | undefined {
  const text = raw.trim().replace(/\s+/g, " ");
  if (isIsoDateTime(text)) return text;
  const zoned = WRITTEN_ZONE.exec(text);
  if (zoned) {
    const written = `${zoned[1]}T${zoned[2]}${offsetText(zoned[3] ?? "")}`;
    return isIsoDateTime(written) ? written : undefined;
  }
  const day = readDayText(text, options.order);
  if (day) return startOfDay(day, options.timeZone);
  const meridiem = MERIDIEM.exec(text);
  const unmarked = meridiem ? text.slice(0, meridiem.index) : text;
  const at = Math.max(unmarked.lastIndexOf(" "), unmarked.lastIndexOf("T"));
  if (at <= 0) return undefined;
  const date = readDayText(text.slice(0, at), options.order);
  const clock = readClock(text.slice(at + 1));
  if (!date || !clock) return undefined;
  const wall =
    wallOfDay(date) +
    clock.hour * 3_600_000 +
    clock.minute * 60_000 +
    clock.second * 1_000;
  const first = instantsOf(options.timeZone, wall)[0];
  return first === undefined ? undefined : instantText(first, clock.fraction);
}

/** The time of a duration written with its days: `1d 1:01`, `1j 1:01`. */
export const DURATION_WITH_DAYS =
  /^(\d+) ?[dj] (\d+):([0-5]\d)(?::([0-5]\d(?:\.\d+)?))?$/;
