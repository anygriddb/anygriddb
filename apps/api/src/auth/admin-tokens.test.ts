import { describe, expect, it } from "vitest";
import { ADMIN_SCOPES, createAdminTokenInputSchema } from "./admin-tokens.js";

describe("a token of the administration API, as it is asked for", () => {
  const asked = (input: unknown) =>
    createAdminTokenInputSchema.safeParse(input).success;

  it("has a name and at least one scope the product has, each once", () => {
    expect(asked({ name: "CI", scopes: ["accounts"] })).toBe(true);
    expect(asked({ name: "CI", scopes: [...ADMIN_SCOPES], days: 30 })).toBe(
      true,
    );
    expect(asked({ name: "CI", scopes: [] })).toBe(false);
    expect(asked({ name: "CI", scopes: ["accounts", "accounts"] })).toBe(false);
    expect(asked({ name: "CI", scopes: ["backups"] })).toBe(false);
    expect(asked({ name: "", scopes: ["accounts"] })).toBe(false);
    expect(asked({ scopes: ["accounts"] })).toBe(false);
  });

  it("lives a whole number of days, a year at most, and takes nothing else", () => {
    expect(asked({ name: "CI", scopes: ["settings"], days: 365 })).toBe(true);
    for (const days of [0, 366, 1.5, "30"]) {
      expect(asked({ name: "CI", scopes: ["settings"], days })).toBe(false);
    }
    // Nothing that would name another maker, or more than a scope gives.
    expect(
      asked({ name: "CI", scopes: ["settings"], createdBy: "someone" }),
    ).toBe(false);
    expect(asked({ name: "CI", scopes: ["settings"], admin: true })).toBe(
      false,
    );
  });
});
