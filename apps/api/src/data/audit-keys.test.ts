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

  it("leaves out what every new row is given, and every deleted row loses", () => {
    const row = {
      id: "r",
      nom: "A",
      ag_status: "draft",
      ag_position: "a0",
      ag_seq: 4,
      ag_created_at: "t1",
      ag_created_by: "u",
      ag_updated_at: "t1",
      ag_updated_by: "u",
    };
    expect(changedKeys(null, row)).toEqual(["nom"]);
    expect(changedKeys(row, null)).toEqual(["nom"]);
  });

  it("names a row's status and its place when they change", () => {
    const row = { id: "r", nom: "A", ag_status: "draft", ag_position: "a0" };
    expect(changedKeys(row, { ...row, ag_status: "locked" })).toEqual([
      "ag_status",
    ]);
    expect(changedKeys(row, { ...row, ag_position: "a1" })).toEqual([
      "ag_position",
    ]);
  });
});
