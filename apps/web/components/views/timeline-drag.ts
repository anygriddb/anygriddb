/**
 * What a timeline's bar writes when the pointer drags it: by its middle,
 * both its dates move; by an edge, that date alone, never past the other.
 * Days are counted where the reader is, as the calendar counts them.
 */
import { dayValue, isoDay } from "./view-days";

/** The part of a bar the pointer took. */
export type BarGrip = "move" | "start" | "end";

/** A date field a bar is drawn from, and what the row holds in it. */
export type BarDate = {
  name: string;
  /** The field keeps a time: a move keeps it. */
  withTime: boolean;
  value: string | null;
};

/** How far the pointer goes before a press is a drag, not a click. */
export const DRAG_THRESHOLD = 4;

/** Days a pointer moved across a scale of `perDay` pixels a day. */
export function draggedDays(pixels: number, perDay: number): number {
  return Math.round(pixels / perDay) || 0;
}

/** The day a date field's value falls on, where the reader is. */
function dayOf(value: string, withTime: boolean): string {
  return withTime ? isoDay(new Date(value)) : value.slice(0, 10);
}

function dayParts(day: string): [number, number, number] {
  const [year, month, date] = day.split("-").map(Number);
  return [year ?? 2000, (month ?? 1) - 1, date ?? 1];
}

/** The day `days` after this one, before it when negative. */
export function addDays(day: string, days: number): string {
  const [year, month, date] = dayParts(day);
  return isoDay(new Date(year, month, date + days));
}

/** The day a date field's value falls on, as a date where the reader is. */
export function dayShown(value: string, withTime: boolean): Date {
  if (withTime) return new Date(value);
  const [year, month, date] = dayParts(value.slice(0, 10));
  return new Date(year, month, date);
}

/** Whole days from one day to another. */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.UTC(...dayParts(to)) - Date.UTC(...dayParts(from))) / 86_400_000,
  );
}

/**
 * What a bar dragged by `days` writes, by the field: both dates moved, or
 * the one its edge holds, which stops at the other. A bar without an end
 * moves as one day, and its right edge gives it one. Null when nothing
 * changes.
 */
export function barDragValues(input: {
  grip: BarGrip;
  days: number;
  start: BarDate;
  end?: BarDate | undefined;
}): Record<string, string> | null {
  const { grip, days, start, end } = input;
  if (days === 0 || start.value === null) return null;
  const startDay = dayOf(start.value, start.withTime);
  const endDay =
    end?.value === null || end === undefined
      ? null
      : dayOf(end.value, end.withTime);
  // A bar ending before it starts is drawn as its first day.
  const span = endDay === null ? 0 : Math.max(0, daysBetween(startDay, endDay));
  const moved = (field: BarDate, from: string, by: number) =>
    dayValue(addDays(from, by), field.withTime, field.value);
  if (grip === "move" || (grip === "start" && endDay === null)) {
    const values = { [start.name]: moved(start, startDay, days) };
    if (end && endDay !== null) values[end.name] = moved(end, endDay, days);
    return values;
  }
  if (grip === "start") {
    const by = Math.min(days, span);
    return by === 0 ? null : { [start.name]: moved(start, startDay, by) };
  }
  if (!end) return null;
  const by = Math.max(days, -span);
  if (by === 0) return null;
  // The edge is where the bar is drawn to: its end, or its first day.
  const lastDay = endDay !== null && span > 0 ? endDay : startDay;
  return { [end.name]: moved(end, lastDay, by) };
}
