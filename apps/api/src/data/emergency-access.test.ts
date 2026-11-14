import type { Binding } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { accessRecordOf, withOpenBases } from "./emergency-access.js";

const base = (scopeId: string, role: Binding["role"]): Binding => ({
  role,
  scope: "base",
  scopeId,
});

describe("withOpenBases", () => {
  it("adds a viewer's role on each base opened", () => {
    expect(withOpenBases([base("a", "owner")], ["b", "c"])).toEqual([
      base("a", "owner"),
      base("b", "viewer"),
      base("c", "viewer"),
    ]);
  });

  it("leaves a role already held as it is, and adds nothing without an opening", () => {
    const held = [base("a", "editor")];
    expect(withOpenBases(held, ["a"])).toEqual(held);
    expect(withOpenBases(held, [])).toEqual(held);
  });
});

describe("accessRecordOf", () => {
  it("reads what the trail keeps of an opening", () => {
    const record = {
      baseId: "b1",
      base: "Ventes",
      until: "2026-11-14T10:00:00Z",
    };
    expect(accessRecordOf({ ...record, extra: 1 })).toEqual(record);
  });

  it("is null for any other event", () => {
    expect(accessRecordOf(null)).toBeNull();
    expect(accessRecordOf({ kind: "view", format: "csv" })).toBeNull();
    expect(accessRecordOf({ baseId: "b1", base: "Ventes" })).toBeNull();
  });
});
