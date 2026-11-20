/**
 * Days as the views that place rows by a date count them, where the
 * reader is: a calendar's month, a timeline's period.
 */

/** The first and last days a view shows, as date fields keep a day. */
export type ShownDays = { from: string; to: string };

/** A date's day where the reader is, as a date field keeps it. */
export function isoDay(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * What a date field takes for a day: the day itself, or, for a field that
 * keeps a time, that day at the time the row already had, and at nine in
 * the morning for a row that had none.
 */
export function dayValue(
  day: string,
  withTime: boolean,
  previous: unknown,
): string {
  if (!withTime) return day;
  const time =
    typeof previous === "string"
      ? new Date(previous)
      : new Date(`${day}T09:00:00`);
  const [year, month, date] = day.split("-").map(Number);
  time.setFullYear(year ?? 2000, (month ?? 1) - 1, date ?? 1);
  return time.toISOString();
}

/** The days of a month, from the first to the last. */
export function monthDays(month: Date): ShownDays {
  return {
    from: isoDay(new Date(month.getFullYear(), month.getMonth(), 1)),
    to: isoDay(new Date(month.getFullYear(), month.getMonth() + 1, 0)),
  };
}

/**
 * The day a row added to a view takes so that the view shows it: today
 * when the days shown hold it, their first day otherwise.
 */
export function dayToAdd(shown: ShownDays, today: Date): string {
  const day = isoDay(today);
  return day >= shown.from && day <= shown.to ? day : shown.from;
}
