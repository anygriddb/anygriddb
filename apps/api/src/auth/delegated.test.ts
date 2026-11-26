import { PERMISSIONS, rolePermissions } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
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
