import { describe, expect, it } from "vitest";
import {
  dayToAdd,
  dayValue,
  isoDay,
  monthDays,
  undrawnOnDay,
} from "./view-days";

describe("isoDay", () => {
  it("writes the day where the reader is, not the day in UTC", () => {
    // The last minute of a day and the first of the next, on the
    // reader's clock: whatever the zone, they are two days.
    expect(isoDay(new Date(2026, 2, 4, 23, 59))).toBe("2026-03-04");
    expect(isoDay(new Date(2026, 2, 5, 0, 0))).toBe("2026-03-05");
  });
});

describe("dayValue", () => {
  it("gives a date field the day", () => {
    expect(dayValue("2026-03-05", false, null)).toBe("2026-03-05");
    expect(dayValue("2026-03-05", false, "2026-03-01")).toBe("2026-03-05");
  });

  it("gives a field with a time nine in the morning that day, for a row that had none", () => {
    expect(dayValue("2026-03-05", true, null)).toBe(
      new Date(2026, 2, 5, 9, 0).toISOString(),
    );
  });

  it("keeps the time a row already had, on its new day", () => {
    const before = new Date(2026, 2, 1, 14, 30).toISOString();
    expect(dayValue("2026-03-05", true, before)).toBe(
      new Date(2026, 2, 5, 14, 30).toISOString(),
    );
  });
});

describe("monthDays", () => {
  it("runs from the first day of the month to its last", () => {
    expect(monthDays(new Date(2026, 1, 1))).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(monthDays(new Date(2028, 1, 17))).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });
});

describe("dayToAdd", () => {
  const march = { from: "2026-03-01", to: "2026-03-31" };

  it("is today when the days shown hold it, their first and last included", () => {
    expect(dayToAdd(march, new Date(2026, 2, 17, 10))).toBe("2026-03-17");
    expect(dayToAdd(march, new Date(2026, 2, 1, 0, 0))).toBe("2026-03-01");
    expect(dayToAdd(march, new Date(2026, 2, 31, 23, 59))).toBe("2026-03-31");
  });

  it("is the first day shown when today is before or after them", () => {
    expect(dayToAdd(march, new Date(2026, 1, 28, 23, 59))).toBe("2026-03-01");
    expect(dayToAdd(march, new Date(2026, 3, 1, 0, 0))).toBe("2026-03-01");
  });

  it("prefers a day the person chose when the days shown hold it", () => {
    expect(dayToAdd(march, new Date(2026, 2, 17, 10), "2026-03-05")).toBe(
      "2026-03-05",
    );
    expect(dayToAdd(march, new Date(2026, 2, 17, 10), "2026-04-01")).toBe(
      "2026-03-17",
    );
    expect(dayToAdd(march, new Date(2026, 2, 17, 10), null)).toBe("2026-03-17");
  });
});

describe("undrawnOnDay", () => {
  it("counts the rows past what a day shows", () => {
    // 1,000 rows on the 1st, all of them read: six are drawn.
    expect(undrawnOnDay(1000, 1000, 6)).toBe(994);
    expect(undrawnOnDay(7, 7, 6)).toBe(1);
  });

  it("counts the rows the calendar's page did not read at all", () => {
    // Three rows on the 15th, past the thousand the page holds: none is
    // drawn, and the day said nothing of them.
    expect(undrawnOnDay(3, 0, 6)).toBe(3);
    expect(undrawnOnDay(5, 2, 6)).toBe(3);
  });

  it("counts none when every row of the day is drawn", () => {
    expect(undrawnOnDay(3, 3, 6)).toBe(0);
    expect(undrawnOnDay(6, 6, 6)).toBe(0);
    expect(undrawnOnDay(0, 0, 6)).toBe(0);
    // No count from the database (a field that keeps a time): what was read.
    expect(undrawnOnDay(undefined, 4, 6)).toBe(0);
    expect(undrawnOnDay(undefined, 9, 6)).toBe(3);
  });
});
