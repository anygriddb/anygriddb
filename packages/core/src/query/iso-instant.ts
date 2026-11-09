/**
 * AnyGridDB's grammar for text read as an instant (ADR 0005), in
 * TypeScript: a date written in a formula is read when the formula
 * compiles, not by SQL on every row. It must agree with the engines'
 * parsers (`textToInstant` in each dialect), which read a field's text.
 */

/** `YYYY-MM-DD`, then `T` or a space and `HH:MM[:SS[.ffffff]]`, then a zone. */
const ISO =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\.[0-9]{1,6})?)?)?\s*(Z|([+-])([0-9]{2})(?::?([0-9]{2}))?)?$/;

export type IsoInstant = {
  /** `YYYY-MM-DD HH:MM:SS[.ffffff]`: the wall clock, or UTC when zoned. */
  timestamp: string;
  /** Whether the text named its zone, so `timestamp` is in UTC. */
  utc: boolean;
};

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * The instant a text names, or null when it is not one: a day that does
 * not exist, an hour past 23, a year before `minYear`.
 */
export function parseIsoInstant(text: string, minYear = 1): IsoInstant | null {
  // The engines trim spaces only.
  const match = ISO.exec(text.replace(/^ +| +$/g, ""));
  if (!match) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const [hour, minute, second] = [match[4], match[5], match[6]].map((part) =>
    Number(part ?? 0),
  ) as [number, number, number];
  const fraction = match[7] ?? "";
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const last =
    month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (
    year < minYear ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > last ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const zone = match[8];
  if (zone === undefined) {
    return {
      timestamp: `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}${fraction}`,
      utc: false,
    };
  }
  const offsetHours = Number(match[10] ?? 0);
  const offsetMinutes = Number(match[11] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const sign = match[9] === "-" ? -1 : 1;
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(
    hour,
    minute - sign * (offsetHours * 60 + offsetMinutes),
    second,
    0,
  );
  return {
    timestamp: `${pad(instant.getUTCFullYear(), 4)}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())} ${pad(instant.getUTCHours())}:${pad(instant.getUTCMinutes())}:${pad(instant.getUTCSeconds())}${fraction}`,
    utc: true,
  };
}
