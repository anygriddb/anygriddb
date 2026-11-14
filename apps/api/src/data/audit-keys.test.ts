import { describe, expect, it } from "vitest";
import { changedKeys } from "./audit-keys.js";

describe("changedKeys", () => {
  it("lists fields whose values differ, without system noise", () => {
    expect(
      changedKeys(
        {
          id: "r",
          nom: "A",
          tags: ["x"],
          ag_updated_at: "t1",
          ag_status: "draft",
        },
        {
          id: "r",
          nom: "B",
          tags: ["x"],
          ag_updated_at: "t2",
          ag_status: "draft",
        },
      ),
    ).toEqual(["nom"]);
  });

  it("treats a missing snapshot as empty", () => {
    expect(changedKeys(null, { id: "r", nom: "A", note: null })).toEqual([
      "nom",
    ]);
    expect(changedKeys({ nom: "A" }, null)).toEqual(["nom"]);
    expect(changedKeys("bad", 3)).toEqual([]);
  });
});
