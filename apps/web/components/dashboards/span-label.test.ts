import { describe, expect, it } from "vitest";
import { groupsDates, quarterOf, spanLabel } from "./span-label";

const quarter = (place: number, year: string) => `Q${String(place)} ${year}`;

describe("spanLabel", () => {
  it("names a month, a quarter, and a year from their first day", () => {
    expect(spanLabel("2026-04-01", "month", "en", quarter)).toBe("Apr 2026");
    expect(spanLabel("2026-04-01", "month", "fr", quarter)).toBe("avr. 2026");
    expect(spanLabel("2026-04-01", "quarter", "en", quarter)).toBe("Q2 2026");
    expect(spanLabel("2026-01-01", "year", "en", quarter)).toBe("2026");
  });

  it("names a week by its Monday, the day first", () => {
    expect(spanLabel("2026-02-23", "week", "en", quarter)).toBe("23 Feb 2026");
  });

  it("keeps the day a key says, wherever the reader's clock is", () => {
    // Noon in UTC is the same day everywhere a browser may be.
    expect(spanLabel("2026-01-01", "month", "en", quarter)).toBe("Jan 2026");
    expect(spanLabel("2025-12-01T00:00:00", "month", "en", quarter)).toBe(
      "Dec 2025",
    );
  });
});

describe("quarterOf", () => {
  it("places a first day in its year", () => {
    expect(quarterOf("2026-01-01")).toBe(1);
    expect(quarterOf("2026-04-01")).toBe(2);
    expect(quarterOf("2026-07-01")).toBe(3);
    expect(quarterOf("2026-10-01")).toBe(4);
  });
});

describe("groupsDates", () => {
  it("takes a date, an instant, and a row's own times", () => {
    for (const type of [
      "date",
      "datetime",
      "created_time",
      "last_modified_time",
    ]) {
      expect(groupsDates(type)).toBe(true);
    }
  });

  it("leaves every other field, and no field at all", () => {
    expect(groupsDates("text")).toBe(false);
    expect(groupsDates("single_select")).toBe(false);
    expect(groupsDates(null)).toBe(false);
    expect(groupsDates(undefined)).toBe(false);
  });
});
