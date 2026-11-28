import type { FilterGroup } from "@anygriddb/core";
import { isoDay } from "./view-days";

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

/**
 * Pixels a day takes: the scale's own, or more when the whole period is
 * narrower than the axis that shows it. At a wide screen's width a
 * quarter left the right fifth of the axis empty; stretched, it fills it,
 * and a drag reads the same width as the bars it moves. Cut to a
 * hundredth of a pixel: the sheet comes within a pixel of the axis's edge
 * and never passes it, which would scroll it sideways.
 */
export function dayWidth(input: {
  /** The scale's own width of a day, the least it takes. */
  least: number;
  /** Days of the period. */
  days: number;
  /** Pixels of the axis that show at once; 0 before it is measured. */
  shown: number;
}): number {
  if (input.days <= 0) return input.least;
  const fitted = Math.floor((input.shown / input.days) * 100) / 100;
  return Math.max(input.least, fitted);
}

/**
 * How far along its axis a period opens, in pixels: today a third of the
 * way into what shows, when the period holds it, so that what is under
 * way and what comes next are both there; at its first day otherwise. A
 * year is wider than the page: opened at January, its bars of the autumn
 * were out of sight and the timeline looked empty.
 */
export function openingScroll(input: {
  /** Days from the period's first day to today; null outside the period. */
  today: number | null;
  /** Pixels a day takes at the scale shown. */
  perDay: number;
  /** Pixels of the axis that show at once. */
  shown: number;
}): number {
  if (input.today === null) return 0;
  return Math.max(0, Math.round(input.today * input.perDay - input.shown / 3));
}

/**
 * Whether a bar this wide has room for its row's name. A bar too short
 * for it showed the first letter cut in two; the name is beside it, at
 * the head of its line.
 */
export function barHoldsName(width: number): boolean {
  return width >= 56;
}

/**
 * The width a bar is opened by: its own, and never less than the least
 * a pointer's target may be (24 pixels). A day's bar is drawn four
 * pixels wide at the scale of a year: drawn so, it is still found.
 */
export function barTarget(width: number): number {
  return Math.max(width, 24);
}

/**
 * The width of the column of names at the left of the axis. On a narrow
 * screen the wide one left the axis less than half of the page.
 */
export function namesWidth(narrow: boolean): number {
  return narrow ? 128 : 224;
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
