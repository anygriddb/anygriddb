import { parseDate } from "@anygriddb/ui";
import { describe, expect, it } from "vitest";
import { endAfter, lastDayOf } from "./role-end";

describe("a role's last day", () => {
  it("ends at the start of the day after it, in the reader's zone", () => {
    const end = endAfter(parseDate("2030-12-31"), "Europe/Paris");
    expect(end).toBe("2030-12-31T23:00:00.000Z");
    expect(lastDayOf(end, "Europe/Paris").toString()).toBe("2030-12-31");
    // Through a change of the clocks, the day stays whole.
    const summer = endAfter(parseDate("2030-03-30"), "Europe/Paris");
    expect(summer).toBe("2030-03-30T23:00:00.000Z");
    expect(lastDayOf(summer, "Europe/Paris").toString()).toBe("2030-03-30");
  });

  it("is never the day the role stops giving", () => {
    expect(
      lastDayOf("2030-12-31T23:00:00.000Z", "Europe/Paris").toString(),
    ).not.toBe("2031-01-01");
    expect(lastDayOf("2031-01-01T00:00:00.000Z", "UTC").toString()).toBe(
      "2030-12-31",
    );
  });
});
