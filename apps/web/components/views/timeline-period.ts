import type { FilterGroup } from "@anygriddb/core";

export type TimelineScale = "day" | "week" | "month";

/** Months one period shows at each scale: a month, a quarter, a year. */
const MONTHS: Record<TimelineScale, number> = { day: 1, week: 3, month: 12 };

/** The scale a view keeps, or weeks when what it keeps is unknown. */
export function timelineScale(value: unknown): TimelineScale {
  return value === "day" || value === "month" ? value : "week";
}

function monthIndex(date: Date): number {
  return date.getFullYear() * 12 + date.getMonth();
}

function fromIndex(index: number): Date {
  return new Date(Math.floor(index / 12), ((index % 12) + 12) % 12, 1);
}

function isoDay(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

type TimelinePeriod = {
  /** The first day shown. */
  first: Date;
  /** The day after the last one shown. */
  next: Date;
  /** The first and last days shown, as ISO dates. */
  from: string;
  to: string;
  /** Days shown. */
  days: number;
};

/**
 * The period that holds `focus` at this scale: its month, its quarter, or
 * its year. Changing the scale keeps the same moment in view.
 */
export function timelinePeriod(
  focus: Date,
  scale: TimelineScale,
): TimelinePeriod {
  const months = MONTHS[scale];
  const index = monthIndex(focus);
  const start = index - (((index % months) + months) % months);
  const first = fromIndex(start);
  const next = fromIndex(start + months);
  const last = new Date(next.getFullYear(), next.getMonth(), 0);
  const days =
    (Date.UTC(next.getFullYear(), next.getMonth(), 1) -
      Date.UTC(first.getFullYear(), first.getMonth(), 1)) /
    86_400_000;
  return { first, next, from: isoDay(first), to: isoDay(last), days };
}

/** The first month of the period before (`-1`) or after (`1`) this one. */
export function shiftPeriod(
  focus: Date,
  scale: TimelineScale,
  step: -1 | 1,
): Date {
  const { first } = timelinePeriod(focus, scale);
  return fromIndex(monthIndex(first) + step * MONTHS[scale]);
}

/**
 * The rows whose bar crosses the period, filtered in the database: those
 * that start before it ends and end, or start, once it has begun. A row
 * without an end is a bar of one day.
 */
export function timelineFilter(
  start: string,
  end: string | undefined,
  period: TimelinePeriod,
): FilterGroup {
  const startsBy = {
    column: start,
    op: "is_on_or_before" as const,
    value: { mode: "exact" as const, date: period.to },
  };
  const startsIn = {
    column: start,
    op: "is_on_or_after" as const,
    value: { mode: "exact" as const, date: period.from },
  };
  if (!end || end === start) {
    return { conjunction: "and", conditions: [startsIn, startsBy] };
  }
  return {
    conjunction: "and",
    conditions: [
      startsBy,
      {
        conjunction: "or",
        conditions: [
          {
            column: end,
            op: "is_on_or_after",
            value: { mode: "exact", date: period.from },
          },
          startsIn,
        ],
      },
    ],
  };
}
