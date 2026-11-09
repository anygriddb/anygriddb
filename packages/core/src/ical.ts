/**
 * An iCalendar document (RFC 5545) of a calendar view's rows, as a
 * calendar application subscribes to it: one VEVENT per row.
 */

/** A day (`2026-02-28`), or an instant (ISO 8601 with its zone). */
export type CalendarMoment = { date: string } | { instant: string };

export type CalendarEvent = {
  /** Stable across reads, so applications update an event in place. */
  uid: string;
  summary: string;
  start: CalendarMoment;
  end?: CalendarMoment;
  url?: string;
};

const UTF8 = new TextEncoder();
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Escapes TEXT: backslash, semicolon, comma, and line breaks. */
export function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Folds a content line at 75 octets, continuation lines starting with a
 * space, never inside a UTF-8 character.
 */
export function foldICalLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = UTF8.encode(char).length;
    // The first line holds 75 octets; the others 74, after their space.
    if (size + bytes > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function day(date: string): string {
  return date.slice(0, 10).replace(/-/g, "");
}

function plusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

function utc(instant: Date): string {
  return `${instant.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function moment(
  name: "DTSTART" | "DTEND",
  value: CalendarMoment,
): string | undefined {
  if ("date" in value) return `${name};VALUE=DATE:${day(value.date)}`;
  const instant = new Date(value.instant);
  return Number.isNaN(instant.getTime())
    ? undefined
    : `${name}:${utc(instant)}`;
}

/**
 * The end an event shows: a day's ends the day after (DTEND is exclusive),
 * a time's an hour later, unless the row gives its own of the same kind.
 */
function endOf(event: CalendarEvent): CalendarMoment | undefined {
  const { start, end } = event;
  if ("date" in start) {
    const last =
      end && "date" in end && end.date >= start.date ? end.date : start.date;
    return { date: plusDays(last, 1) };
  }
  const from = new Date(start.instant).getTime();
  if (Number.isNaN(from)) return undefined;
  if (end && "instant" in end && new Date(end.instant).getTime() > from) {
    return end;
  }
  return { instant: new Date(from + HOUR).toISOString() };
}

/** The document: CRLF line ends, lines folded, every text escaped. */
export function buildICalendar(input: {
  name: string;
  events: readonly CalendarEvent[];
  now: Date;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AnyGridDB//Calendar feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeICalText(input.name)}`,
  ];
  const stamp = utc(input.now);
  for (const event of input.events) {
    const start = moment("DTSTART", event.start);
    const end = endOf(event);
    if (!start || !end) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeICalText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      start,
      moment("DTEND", end) ?? "",
      `SUMMARY:${escapeICalText(event.summary)}`,
      ...(event.url ? [`URL:${event.url}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines
    .filter((line) => line !== "")
    .map(foldICalLine)
    .join("\r\n")}\r\n`;
}
