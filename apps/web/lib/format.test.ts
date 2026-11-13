import { describe, expect, it } from "vitest";
import { formatAgo } from "./format";

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
