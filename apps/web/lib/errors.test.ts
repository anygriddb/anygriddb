import { describe, expect, it } from "vitest";
import { hasReason, refusedAs } from "./errors";

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

describe("refusedAs", () => {
  it("knows the server said that the thing is not there", () => {
    expect(
      refusedAs(
        { data: { reason: { code: "unknown_share" } }, message: "x" },
        "unknown_share",
      ),
    ).toBe(true);
    expect(
      refusedAs(
        { data: { reason: { code: "invalid_invitation" } }, message: "x" },
        "unknown_share",
        "invalid_invitation",
      ),
    ).toBe(true);
  });

  it("knows a read that failed another way, which says nothing of the thing", () => {
    // A fault of the server, a refusal of another kind, the network gone.
    expect(
      refusedAs(
        { data: { httpStatus: 500, reason: { code: "internal_error" } } },
        "unknown_share",
      ),
    ).toBe(false);
    expect(
      refusedAs(
        { data: { reason: { code: "request_rejected" } } },
        "unknown_share",
      ),
    ).toBe(false);
    expect(refusedAs(new TypeError("Failed to fetch"), "unknown_share")).toBe(
      false,
    );
    expect(
      refusedAs({ data: { httpStatus: 502 }, message: "x" }, "unknown_share"),
    ).toBe(false);
    expect(refusedAs(undefined, "unknown_share")).toBe(false);
  });
});
