const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The time of a day in UTC. `Date.UTC` reads the years 0 to 99 as 19xx,
 * so the year is set on its own.
 */
export function utcMillis(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/** Whether a text is a calendar day that exists, written `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(utcMillis(year, month, day));
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Whether a text is an instant, with its zone, whose day exists and whose
 * year in UTC is one a field takes: an offset can carry the last hours of
 * the year 9999 into the next.
 */
export function isIsoDateTime(value: string): boolean {
  if (!ISO_DATETIME.test(value) || !isIsoDate(value.slice(0, 10))) {
    return false;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const year = new Date(time).getUTCFullYear();
  return year >= 1 && year <= 9_999;
}
