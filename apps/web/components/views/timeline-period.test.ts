import { describe, expect, it } from "vitest";
import {
  shiftPeriod,
  timelineFilter,
  timelinePeriod,
  timelineScale,
} from "./timeline-period";

describe("timelinePeriod", () => {
  it("shows the month, the quarter, or the year that holds the focus", () => {
    const focus = new Date(2026, 10, 1);
    expect(timelinePeriod(focus, "day")).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-30",
      days: 30,
    });
    expect(timelinePeriod(focus, "week")).toMatchObject({
      from: "2026-10-01",
      to: "2026-12-31",
      days: 92,
    });
    expect(timelinePeriod(focus, "month")).toMatchObject({
      from: "2026-01-01",
      to: "2026-12-31",
      days: 365,
    });
  });

  it("counts a leap February", () => {
    expect(timelinePeriod(new Date(2028, 1, 1), "day")).toMatchObject({
      to: "2028-02-29",
      days: 29,
    });
  });
});

describe("shiftPeriod", () => {
  it("moves by one period, across years", () => {
    expect(shiftPeriod(new Date(2026, 11, 1), "day", 1)).toEqual(
      new Date(2027, 0, 1),
    );
    expect(shiftPeriod(new Date(2026, 1, 1), "week", -1)).toEqual(
      new Date(2025, 9, 1),
    );
    expect(shiftPeriod(new Date(2026, 6, 1), "month", 1)).toEqual(
      new Date(2027, 0, 1),
    );
  });
});

describe("timelineScale", () => {
  it("keeps a known scale and falls back to weeks", () => {
    expect(timelineScale("day")).toBe("day");
    expect(timelineScale("month")).toBe("month");
    expect(timelineScale("decade")).toBe("week");
    expect(timelineScale(undefined)).toBe("week");
  });
});

describe("timelineFilter", () => {
  const period = timelinePeriod(new Date(2026, 10, 1), "day");

  it("keeps the rows that start within the period, without an end", () => {
    expect(timelineFilter("starts", undefined, period)).toEqual({
      conjunction: "and",
      conditions: [
        {
          column: "starts",
          op: "is_on_or_after",
          value: { mode: "exact", date: "2026-11-01" },
        },
        {
          column: "starts",
          op: "is_on_or_before",
          value: { mode: "exact", date: "2026-11-30" },
        },
      ],
    });
  });

  it("keeps a bar that began before the period and ends inside it", () => {
    const filter = timelineFilter("starts", "ends", period);
    expect(filter.conditions[0]).toEqual({
      column: "starts",
      op: "is_on_or_before",
      value: { mode: "exact", date: "2026-11-30" },
    });
    expect(filter.conditions[1]).toEqual({
      conjunction: "or",
      conditions: [
        {
          column: "ends",
          op: "is_on_or_after",
          value: { mode: "exact", date: "2026-11-01" },
        },
        {
          column: "starts",
          op: "is_on_or_after",
          value: { mode: "exact", date: "2026-11-01" },
        },
      ],
    });
  });
});
