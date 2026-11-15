import { describe, expect, it } from "vitest";
import { USAGE_TREND_DAYS } from "./usage-stats.js";

describe("usage stats", () => {
  it("keeps a ninety-day trend window", () => {
    expect(USAGE_TREND_DAYS).toBe(90);
  });
});
