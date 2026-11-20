import { intlLocale } from "../../lib/format";

/** What a category of dates covers, past a day. */
export type DateSpan = "week" | "month" | "quarter" | "year";

/** The fields whose groups are dates: a date, an instant, a row's own. */
const DATED = new Set([
  "date",
  "datetime",
  "created_time",
  "last_modified_time",
]);

/** Whether a chart grouped by a field of this type groups dates. */
export function groupsDates(fieldType: string | null | undefined): boolean {
  return DATED.has(fieldType ?? "");
}

/** A quarter's place in its year, from the first day it is named by. */
export function quarterOf(key: string): number {
  return Math.floor((Number(key.slice(5, 7)) - 1) / 3) + 1;
}

/**
 * A category of dates as people read it, from the first day it is named
 * by: a week by its Monday, a month by its name and year, a quarter as
 * `quarter` writes it, a year by its number.
 */
export function spanLabel(
  key: string,
  span: DateSpan,
  language: string,
  quarter: (place: number, year: string) => string,
): string {
  const year = key.slice(0, 4);
  if (span === "year") return year;
  if (span === "quarter") return quarter(quarterOf(key), year);
  return new Intl.DateTimeFormat(
    intlLocale(language),
    span === "month"
      ? { month: "short", year: "numeric", timeZone: "UTC" }
      : { dateStyle: "medium", timeZone: "UTC" },
  ).format(new Date(`${key.slice(0, 10)}T12:00:00Z`));
}
