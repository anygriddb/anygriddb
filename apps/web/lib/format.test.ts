import { describe, expect, it } from "vitest";
import {
  formatAggregate,
  formatAgo,
  formatClock,
  formatDay,
  formatInstant,
  intlLocale,
} from "./format";

const NOW = Date.parse("2026-03-17T12:00:00Z");

describe("formatAgo", () => {
  it("says how long ago, in the largest unit that fits", () => {
    expect(formatAgo("2026-03-17T11:59:50Z", "en", NOW)).toBe("now");
    expect(formatAgo("2026-03-17T11:40:00Z", "en", NOW)).toBe("20 minutes ago");
    expect(formatAgo("2026-03-17T10:00:00Z", "en", NOW)).toBe("2 hours ago");
    expect(formatAgo("2026-03-16T09:00:00Z", "en", NOW)).toBe("yesterday");
    expect(formatAgo("2026-03-17T10:00:00Z", "fr", NOW)).toBe(
      "il y a 2 heures",
    );
  });

  it("gives back what is not an instant", () => {
    expect(formatAgo("not a date", "en", NOW)).toBe("not a date");
  });
});

// An evening of November where the test runs, whatever its time zone.
const EVENING = new Date(2026, 10, 19, 20, 56, 18);

describe("an instant, written for a person", () => {
  it("puts the day first and counts 24 hours, in English and in French", () => {
    expect(formatInstant(EVENING, "en")).toBe("19/11/2026, 20:56:18");
    expect(formatInstant(EVENING, "fr")).toBe("19/11/2026 20:56:18");
    expect(formatDay(EVENING, "en")).toBe("19/11/2026");
    expect(formatClock(EVENING, "en")).toBe("20:56");
    expect(formatClock(EVENING, "fr")).toBe("20:56");
  });

  it("never follows a language the app does not speak into its habits", () => {
    // Month first and a clock of 12 hours, as `en-US` writes them, would
    // make the same instant read as another day.
    expect(intlLocale("en-US")).toBe("en-GB");
    expect(intlLocale("de")).toBe("en-GB");
    expect(formatDay(new Date(2026, 3, 3), "en-US")).toBe("03/04/2026");
  });
});

describe("formatAggregate", () => {
  /** Intl parts a number with narrow and no-break spaces: read as one kind. */
  const plain = (text: string) => text.replace(/\s/g, " ");
  const euros = {
    kind: "number",
    config: { number: { style: "currency", currency: "EUR", precision: 2 } },
  } as const;
  const bare = { kind: "number", config: {} } as const;

  it("writes a sum, a mean, or an extreme of a field as the field is written", () => {
    expect(plain(formatAggregate("1234.5", "sum", euros, "fr"))).toBe(
      "1 234,50 €",
    );
    expect(formatAggregate("1234.5", "max", euros, "en")).toBe("€1,234.50");
  });

  it("writes a count or a share of a field of euros as a number, not as euros", () => {
    expect(formatAggregate(42, "count_filled", euros, "en")).toBe("42");
    expect(formatAggregate("87.5", "percent_filled", euros, "en")).toBe(
      "87.5 %",
    );
  });

  it("holds a field with no precision to the decimals it is given", () => {
    expect(formatAggregate("12.3333333333", "avg", bare, "en", 2)).toBe(
      "12.33",
    );
    expect(formatAggregate("1234", "sum", bare, "en", 2)).toBe("1,234");
    // A precision the field sets is the field's own.
    expect(formatAggregate("12.3333", "avg", euros, "en", 0)).toBe("€12.33");
  });

  it("writes a number without its field, and a dash for no value", () => {
    expect(formatAggregate("1234.5", "sum", undefined, "en")).toBe("1,234.5");
    expect(formatAggregate(null, "sum", euros, "en")).toBe("—");
  });

  it("writes the earliest and the latest as dates", () => {
    const day = { kind: "date", config: {} } as const;
    expect(formatAggregate("2026-04-03", "earliest", day, "en")).toMatch(
      /^03\/04\/2026$/,
    );
  });
});
