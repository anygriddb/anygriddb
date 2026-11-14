import { describe, expect, it } from "vitest";
import type { DateMode, FilterKind, WithinMode } from "./filter";
import { evaluateFilter } from "./filter-eval";

const context = {
  kinds: new Map<string, FilterKind>([["due", "date"]]),
  timeZone: "Europe/Paris",
  // Monday 9 March 2026, 00:30 in Paris (23:30 UTC the day before).
  now: new Date("2026-03-08T23:30:00Z"),
};

function matches(
  op: "is" | "is_within",
  mode: DateMode | WithinMode,
  due: string,
) {
  return evaluateFilter(
    {
      conjunction: "and",
      conditions: [{ column: "due", op, value: { mode } }],
    },
    { due },
    context,
  );
}

function shift(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

describe("a date condition's calendar periods, read in the application", () => {
  it.each([
    ["this_week", "2026-03-09", "2026-03-15"],
    ["last_week", "2026-03-02", "2026-03-08"],
    ["next_week", "2026-03-16", "2026-03-22"],
    ["this_month", "2026-03-01", "2026-03-31"],
    ["last_month", "2026-02-01", "2026-02-28"],
    ["next_month", "2026-04-01", "2026-04-30"],
    ["this_year", "2026-01-01", "2026-12-31"],
    ["last_year", "2025-01-01", "2025-12-31"],
    ["next_year", "2027-01-01", "2027-12-31"],
  ] as const)("%s runs from %s to %s, both included", (mode, first, last) => {
    expect(matches("is", mode, first)).toBe(true);
    expect(matches("is", mode, last)).toBe(true);
    expect(matches("is", mode, shift(first, -1))).toBe(false);
    expect(matches("is", mode, shift(last, 1))).toBe(false);
  });

  it.each([
    ["this_week", "2026-03-09", "2026-03-15"],
    ["this_month", "2026-03-01", "2026-03-31"],
    ["this_year", "2026-01-01", "2026-12-31"],
  ] as const)(
    "within %s is the same period, from %s to %s",
    (mode, first, last) => {
      expect(matches("is_within", mode, first)).toBe(true);
      expect(matches("is_within", mode, last)).toBe(true);
      expect(matches("is_within", mode, shift(first, -1))).toBe(false);
      expect(matches("is_within", mode, shift(last, 1))).toBe(false);
    },
  );

  it("within next_month is a month from today, not the month after this one", () => {
    expect(matches("is_within", "next_month", "2026-03-09")).toBe(true);
    expect(matches("is_within", "next_month", "2026-04-09")).toBe(true);
    expect(matches("is_within", "next_month", "2026-04-10")).toBe(false);
    expect(matches("is", "next_month", "2026-03-09")).toBe(false);
  });
});
