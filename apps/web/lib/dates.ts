/**
 * Dates between cells and React Aria's date fields. A date cell holds a
 * day (`2026-03-14`); a date and time cell an instant (ISO 8601), shown
 * and edited in its field's time zone, else the reader's.
 */
import {
  getLocalTimeZone,
  now,
  parseAbsolute,
  parseDate,
  parseDateTime,
  toCalendarDate,
  toZoned,
  type DateValue,
} from "@anygriddb/ui";
import type { DateFormat } from "@anygriddb/core";
import type { CatalogColumn } from "./types";

type Locale = "fr" | "en";

/** A field's date settings, from its configuration. */
export function dateFormatOf(column: CatalogColumn): DateFormat {
  return (column.config as { date?: DateFormat }).date ?? {};
}

/**
 * The locale a date field's segments follow: the field's order (month
 * first, or year first) in the reader's language where one has it.
 */
export function dateFieldLocale(locale: Locale, format?: string): string {
  if (format === "us") return "en-US";
  if (format === "iso") return locale === "fr" ? "fr-CA" : "en-CA";
  return locale === "fr" ? "fr-FR" : "en-GB";
}

/** The zone a date and time is edited in: the field's, else the reader's. */
export function editZone(format: DateFormat): string {
  return format.timeZone ?? getLocalTimeZone();
}

/**
 * A cell's value as a field's: a day, or an instant in `zone`. A date and
 * time written without its zone (`2026-03-14T10:00`, as a form's link may
 * give it) is read in `zone`.
 */
export function toDateValue(
  value: unknown,
  withTime: boolean,
  zone: string,
): DateValue | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    if (!withTime) return parseDate(value.slice(0, 10));
    try {
      return parseAbsolute(value, zone);
    } catch {
      return toZoned(parseDateTime(value.slice(0, 19)), zone);
    }
  } catch {
    return null;
  }
}

/** A form's date and time as an instant, read as its field shows it. */
export function formInstant(text: string, zone: string): string | undefined {
  return fromDateValue(toDateValue(text, true, zone), true) ?? undefined;
}

/** A field's value as a cell's: `2026-03-14`, or an ISO instant. */
export function fromDateValue(
  value: DateValue | null,
  withTime: boolean,
): string | null {
  if (!value) return null;
  if (withTime) {
    return "timeZone" in value
      ? value.toAbsoluteString()
      : value.toDate(getLocalTimeZone()).toISOString();
  }
  return toCalendarDate(value).toString();
}

/** Whether two cell values name the same day or instant. */
export function sameDate(
  a: unknown,
  b: string | null,
  withTime: boolean,
): boolean {
  const left = typeof a === "string" && a !== "" ? a : null;
  if (left === null || b === null) return left === b;
  if (!withTime) return left.slice(0, 10) === b;
  return new Date(left).getTime() === new Date(b).getTime();
}

/** Where an empty date and time field starts: this hour, in `zone`. */
export function startingPoint(zone: string): DateValue {
  return now(zone).set({ minute: 0, second: 0, millisecond: 0 });
}
