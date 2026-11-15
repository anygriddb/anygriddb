import { describe, expect, it } from "vitest";
import {
  changesSearchSchema,
  nextChanges,
  signInSearchSchema,
  toggleChangesDir,
  toggleSignInDir,
  trailRangeInvalid,
} from "./trail-search";

describe("a trail's address", () => {
  it("keeps a known action and a range, and drops the rest", () => {
    expect(
      changesSearchSchema.parse({
        action: "export",
        source: " web ",
        from: "2026-01-01T00:00:00.000Z",
        to: "later",
        dir: "asc",
        sort: "author",
      }),
    ).toEqual({
      action: "export",
      source: "web",
      from: "2026-01-01T00:00:00.000Z",
      dir: "asc",
    });
    expect(signInSearchSchema.parse({ action: "login_failure" })).toEqual({
      action: "login_failure",
    });
    expect(signInSearchSchema.parse({ action: "nope" })).toEqual({});
  });

  it("leaves newest-first out of the address, and turns it round", () => {
    expect(toggleChangesDir({})).toEqual({ dir: "asc" });
    expect(toggleChangesDir({ dir: "asc", action: "insert" })).toEqual({
      action: "insert",
    });
    expect(toggleSignInDir({})).toEqual({ dir: "asc" });
    expect(nextChanges({ source: "web" }, { source: "" })).toEqual({});
  });

  it("knows when the start is after the end", () => {
    expect(
      trailRangeInvalid({
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(trailRangeInvalid({ from: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });
});
