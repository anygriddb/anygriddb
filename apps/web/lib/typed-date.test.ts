import { describe, expect, it } from "vitest";
import { fromDateValue, toDateValue } from "./dates";
import { readTypedDate, typedDate, type TypedSegment } from "./typed-date";

const ZONE = "Europe/Paris";

const day = (d: number, m: number, y: number): TypedSegment[] => [
  { type: "day", value: d },
  { type: "month", value: m },
  { type: "year", value: y },
];
const at = (
  d: number,
  m: number,
  y: number,
  hour: number,
  minute: number,
): TypedSegment[] => [
  ...day(d, m, y),
  { type: "hour", value: hour },
  { type: "minute", value: minute },
];
const written = (segments: TypedSegment[], withTime = false) => {
  const typed = typedDate(segments, "typed", { withTime, zone: ZONE });
  return typed.state === "date"
    ? fromDateValue(typed.value, withTime)
    : typed.state;
};

describe("typedDate", () => {
  it("reads a day that exists", () => {
    expect(written(day(31, 3, 2026))).toBe("2026-03-31");
    expect(written(day(29, 2, 2028))).toBe("2028-02-29");
  });

  it("refuses a day its month does not have", () => {
    expect(written(day(31, 4, 2026))).toBe("impossible");
    expect(written(day(30, 2, 2026))).toBe("impossible");
    expect(written(day(29, 2, 2026))).toBe("impossible");
  });

  it("reads a time, in the field's zone", () => {
    expect(written(at(14, 3, 2026, 10, 30), true)).toBe(
      "2026-03-14T09:30:00.000Z",
    );
  });

  it("refuses an hour the clocks skip that day", () => {
    expect(written(at(29, 3, 2026, 2, 30), true)).toBe("impossible");
    expect(written(at(29, 3, 2026, 3, 30), true)).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("refuses a date and time whose day does not exist", () => {
    expect(written(at(31, 4, 2026, 10, 30), true)).toBe("impossible");
  });

  it("reads a twelve-hour clock with its period", () => {
    const afternoon: TypedSegment[] = [
      ...at(14, 3, 2026, 2, 30),
      { type: "dayPeriod", value: 1 },
    ];
    const midnight: TypedSegment[] = [
      ...at(14, 3, 2026, 12, 0),
      { type: "dayPeriod", value: 0 },
    ];
    expect(written(afternoon, true)).toBe("2026-03-14T13:30:00.000Z");
    expect(written(midnight, true)).toBe("2026-03-13T23:00:00.000Z");
  });

  it("says when nothing, or only a part, was typed", () => {
    const blank = day(1, 1, 2026).map((part) => ({ ...part, value: null }));
    expect(written(blank)).toBe("empty");
    expect(
      written([
        { type: "day", value: 12 },
        { type: "month", value: null },
        { type: "year", value: 2026 },
      ]),
    ).toBe("partial");
  });

  it("keeps the value held when the segments still say it", () => {
    // The second 02:30 of the night the clocks go back, seconds included.
    const held = toDateValue("2026-10-25T01:30:15Z", true, ZONE);
    const typed = typedDate(at(25, 10, 2026, 2, 30), "typed", {
      withTime: true,
      zone: ZONE,
      held,
    });
    expect(typed.state === "date" && fromDateValue(typed.value, true)).toBe(
      "2026-10-25T01:30:15.000Z",
    );
  });
});

describe("readTypedDate", () => {
  /** The attributes a date field's segments carry. */
  const field = (
    parts: Array<{ type: string; now?: number; blank?: boolean }>,
    text = "30/02/2026",
  ) =>
    ({
      textContent: `⁦${text}⁩`,
      querySelectorAll: () =>
        parts.map((part) => ({
          getAttribute: (name: string) =>
            name === "data-type"
              ? part.type
              : name === "aria-valuenow" && part.now !== undefined
                ? String(part.now)
                : null,
          hasAttribute: (name: string) =>
            name === "data-placeholder" && part.blank === true,
        })),
    }) as unknown as ParentNode;

  it("reads what the segments show, and its text", () => {
    const typed = readTypedDate(
      field([
        { type: "day", now: 30 },
        { type: "month", now: 2 },
        { type: "year", now: 2026 },
      ]),
      { withTime: false, zone: ZONE },
    );
    expect(typed).toEqual({ state: "impossible", text: "30/02/2026" });
  });

  it("takes a segment still blank for a value not typed", () => {
    const typed = readTypedDate(
      field([
        { type: "day", now: 12 },
        { type: "month", now: 3, blank: true },
        { type: "year", now: 2026 },
      ]),
      { withTime: false, zone: ZONE },
    );
    expect(typed.state).toBe("partial");
  });
});
