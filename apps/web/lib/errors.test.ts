import { describe, expect, it } from "vitest";
import { hasReason } from "./errors";

describe("hasReason", () => {
  it("knows a failure the server explained", () => {
    expect(
      hasReason({ data: { reason: { code: "unknown_table" } }, message: "x" }),
    ).toBe(true);
    expect(hasReason({ code: "source_timeout", error: "x" })).toBe(true);
  });

  it("knows a call that never reached the server", () => {
    expect(hasReason(new TypeError("Failed to fetch"))).toBe(false);
    expect(
      hasReason({ data: { httpStatus: 502 }, message: "Bad Gateway" }),
    ).toBe(false);
    expect(hasReason({ code: "made_up" })).toBe(false);
    expect(hasReason(undefined)).toBe(false);
  });
});
