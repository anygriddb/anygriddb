import { describe, expect, it } from "vitest";
import { endOfChosenDay } from "./rights-at";

describe("endOfChosenDay", () => {
  it("is the end of that local day", () => {
    const end = endOfChosenDay("2026-06-01");
    expect(end).toBeTruthy();
    const date = new Date(end ?? "");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(5);
    expect(date.getDate()).toBe(1);
    expect(date.getHours()).toBe(23);
    expect(date.getMinutes()).toBe(59);
  });

  it("refuses a day that is not a date", () => {
    expect(endOfChosenDay("")).toBeNull();
    expect(endOfChosenDay("2026-02-31")).toBeNull();
    expect(endOfChosenDay("15/06/2026")).toBeNull();
  });
});
