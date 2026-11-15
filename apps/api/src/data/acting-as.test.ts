import { describe, expect, it } from "vitest";
import { actingRefusal, cleanActingReason } from "./acting-as.js";

const person = {
  id: "00000000-0000-4000-8000-000000000002",
  displayName: "Sam",
  email: "sam@example.org",
  isAdmin: false,
  isSupport: false,
  isAuditor: false,
  disabledAt: null,
};

describe("who an administrator may act as", () => {
  it("accepts an ordinary person", () => {
    expect(actingRefusal("00000000-0000-4000-8000-000000000001", person)).toBe(
      null,
    );
  });

  it("refuses the administrator, a privileged account, and a disabled one", () => {
    const actor = "00000000-0000-4000-8000-000000000001";
    expect(actingRefusal(actor, { ...person, id: actor })).toBe("self");
    expect(actingRefusal(actor, undefined)).toBe("missing");
    expect(actingRefusal(actor, { ...person, isAdmin: true })).toBe(
      "privileged",
    );
    expect(actingRefusal(actor, { ...person, isSupport: true })).toBe(
      "privileged",
    );
    expect(actingRefusal(actor, { ...person, isAuditor: true })).toBe(
      "privileged",
    );
    expect(actingRefusal(actor, { ...person, disabledAt: new Date() })).toBe(
      "disabled",
    );
    expect(
      actingRefusal(actor, {
        ...person,
        id: "00000000-0000-0000-0000-000000000000",
      }),
    ).toBe("tombstone");
  });

  it("keeps a reason on one line and refuses an empty one", () => {
    expect(cleanActingReason("  a reason \n given ")).toBe("a reason given");
    expect(() => cleanActingReason("   ")).toThrow();
    expect(() => cleanActingReason("x".repeat(201))).toThrow();
  });
});
