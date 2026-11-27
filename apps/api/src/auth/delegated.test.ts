import { PERMISSIONS, rolePermissions } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  accessEnd,
  entrustedOf,
  hashSecret,
  permissionsOf,
  switchesOf,
  tokenEnd,
} from "./delegated.js";

describe("what a token is entrusted", () => {
  it("is a viewer's part when read-only, all but deleting when kept from it", () => {
    expect(entrustedOf({ readOnly: true })).toEqual(rolePermissions("viewer"));
    // Read-only wins over a delete the same choice allowed.
    expect(entrustedOf({ readOnly: true, allowDelete: true })).toEqual(
      rolePermissions("viewer"),
    );
    expect(entrustedOf({ allowDelete: false })).toEqual(
      PERMISSIONS.filter((permission) => permission !== "rows.delete"),
    );
    expect(entrustedOf({})).toBeNull();
    expect(entrustedOf({ readOnly: false, allowDelete: true })).toBeNull();
  });

  it("reads back the switches it was made from", () => {
    for (const switches of [
      { readOnly: true },
      { allowDelete: false },
      {},
    ] as const) {
      const back = switchesOf(entrustedOf(switches));
      expect(back.readOnly).toBe("readOnly" in switches);
      expect(back.allowDelete).toBe(
        !("readOnly" in switches) && !("allowDelete" in switches),
      );
    }
  });

  it("keeps only the catalogue's permissions, in its order", () => {
    expect(permissionsOf(["rows.write", "nonsense", "rows.read"])).toEqual([
      "rows.read",
      "rows.write",
    ]);
    expect(permissionsOf(null)).toBeNull();
  });
});

describe("a secret and its end", () => {
  it("keeps a secret as its SHA-256, never itself", () => {
    const hash = hashSecret("ag_example");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("example");
    expect(hashSecret("ag_example")).toBe(hash);
  });

  it("refuses a token with no end", () => {
    const end = new Date("2026-12-01T00:00:00Z");
    expect(tokenEnd(end)).toBe(end);
    expect(() => tokenEnd(null)).toThrow();
  });
});

describe("when a new feed or link ends", () => {
  const now = Date.parse("2026-11-27T00:00:00Z");
  const day = 86_400_000;

  it("lives the days asked, or the instance's longest", () => {
    const policy = { tokenMaxDays: 30 };
    expect(accessEnd(7, policy, now).getTime()).toBe(now + 7 * day);
    expect(accessEnd(undefined, policy, now).getTime()).toBe(now + 30 * day);
    expect(accessEnd(30, policy, now).getTime()).toBe(now + 30 * day);
  });

  it("refuses to outlive the instance's longest", () => {
    expect(() => accessEnd(31, { tokenMaxDays: 30 }, now)).toThrow(
      expect.objectContaining({ code: "token_lifetime_too_long" }),
    );
  });
});
