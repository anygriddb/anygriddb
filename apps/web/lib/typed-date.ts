/**
 * What a date field's segments say. React Aria holds a date that does not
 * exist (30 February, an hour the clocks skip) while it is typed, emits
 * nothing for it, and moves it to a real one when the field loses focus:
 * read before that, the segments are the only place that holds what the
 * person wrote.
 */
import {
  CalendarDate,
  CalendarDateTime,
  toZoned,
  type DateValue,
} from "@anygriddb/ui";

/** One editable part of the field: its kind, and its value when it has one. */
export type TypedSegment = { type: string; value: number | null };

export type TypedDate =
  /** The field's parts could not be read: what it emitted is all there is. */
  | { state: "unread" }
  /** Nothing is written in the field. */
  | { state: "empty" }
  /** Some parts are still blank. */
  | { state: "partial"; text: string }
  /** Every part is written, and together they name no date. */
  | { state: "impossible"; text: string }
  | { state: "date"; value: DateValue; text: string };

type Reading = {
  withTime: boolean;
  /** The zone a date and time is written in. */
  zone: string;
  /** What the field holds: kept when the segments still say it. */
  held?: DateValue | null;
};

const PARTS = new Set(["day", "month", "year", "hour", "minute", "dayPeriod"]);

type Fields = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function fieldsOf(segments: readonly TypedSegment[]): Fields {
  const part = (type: string) =>
    segments.find((segment) => segment.type === type)?.value ?? 0;
  const period = segments.find((segment) => segment.type === "dayPeriod");
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour:
      period === undefined
        ? part("hour")
        : (part("hour") % 12) + (period.value ?? 0) * 12,
    minute: part("minute"),
  };
}

/** The date these fields name; null when it does not exist. */
function dateOf(fields: Fields, withTime: boolean, zone: string) {
  const { year, month, day, hour, minute } = fields;
  // Both constructors move a day past its month's end back into it.
  if (!withTime) {
    const date = new CalendarDate(year, month, day);
    return date.day === day && date.month === month ? date : null;
  }
  const local = new CalendarDateTime(year, month, day, hour, minute);
  if (local.day !== day || local.month !== month) return null;
  const zoned = toZoned(local, zone);
  return zoned.day === day && zoned.hour === hour && zoned.minute === minute
    ? zoned
    : null;
}

function says(value: DateValue, fields: Fields, withTime: boolean): boolean {
  const same =
    value.year === fields.year &&
    value.month === fields.month &&
    value.day === fields.day;
  if (!withTime) return same;
  return (
    same &&
    "hour" in value &&
    value.hour === fields.hour &&
    value.minute === fields.minute
  );
}

/** What these segments say, written as `text` on the screen. */
export function typedDate(
  segments: readonly TypedSegment[],
  text: string,
  { withTime, zone, held }: Reading,
): TypedDate {
  const parts = segments.filter((segment) => PARTS.has(segment.type));
  if (
    parts.length === 0 ||
    parts.some((segment) => Number.isNaN(segment.value))
  ) {
    return { state: "unread" };
  }
  const blank = parts.filter((segment) => segment.value === null).length;
  if (blank === parts.length) return { state: "empty" };
  if (blank > 0) return { state: "partial", text };
  const fields = fieldsOf(parts);
  const value = dateOf(fields, withTime, zone);
  if (!value) return { state: "impossible", text };
  // What is held keeps its seconds and, the night the clocks go back,
  // which of the two times it is.
  return {
    state: "date",
    value: held && says(held, fields, withTime) ? held : value,
    text,
  };
}

/** The text of a field, without the marks that keep a time left to right. */
export function shownDate(root: ParentNode): string {
  return (root.textContent ?? "").replace(/[⁦-⁩]/g, "").trim();
}

const SEGMENTS = [...PARTS].map((type) => `[data-type="${type}"]`).join(",");

/**
 * Reads a date field's segments as they stand on the screen. A touch
 * screen's segments are plain text boxes, without a value of their own:
 * their text is read instead.
 */
export function readTypedDate(root: ParentNode, reading: Reading): TypedDate {
  const segments = [...root.querySelectorAll(SEGMENTS)].map((element) => {
    const now = element.getAttribute("aria-valuenow");
    return {
      type: element.getAttribute("data-type") ?? "",
      value: element.hasAttribute("data-placeholder")
        ? null
        : Number(now ?? element.textContent),
    };
  });
  return typedDate(segments, shownDate(root), reading);
}

/**
 * What a form holds for a date that was typed and does not exist: no field
 * reads it as a date, so the form refuses to send it.
 */
export const UNREADABLE_DATE = "not-a-date";
