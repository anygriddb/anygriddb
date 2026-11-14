import { accountExportJobInputSchema } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { accountExportInputSchema, changedFields } from "./account-export.js";

describe("an account's data export, its input", () => {
  it("takes an account's id", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(accountExportInputSchema.parse({ userId: id })).toEqual({
      userId: id,
    });
    expect(accountExportJobInputSchema.parse({ userId: id })).toEqual({
      userId: id,
    });
  });

  it("refuses what is no id, and a key it does not know", () => {
    expect(() =>
      accountExportInputSchema.parse({ userId: "not-a-uuid" }),
    ).toThrow();
    expect(() =>
      accountExportJobInputSchema.parse({
        userId: "11111111-1111-4111-8111-111111111111",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("changedFields", () => {
  const row = {
    id: "r1",
    ag_updated_at: "t1",
    title: "A",
    count: 1,
    tags: ["x"],
  };

  it("names the fields whose value differs, not every field of the row", () => {
    expect(
      changedFields(row, { ...row, ag_updated_at: "t2", title: "B" }),
    ).toEqual(["title"]);
    expect(changedFields(row, { ...row, tags: ["x", "y"], count: 2 })).toEqual([
      "count",
      "tags",
    ]);
    // The row's own clock moved, and nothing a person wrote.
    expect(changedFields(row, { ...row, ag_updated_at: "t2" })).toEqual([]);
  });

  it("names what a new row filled, and nothing for a row deleted", () => {
    expect(changedFields(null, { ...row, notes: null, extra: "" })).toEqual([
      "count",
      "tags",
      "title",
    ]);
    expect(changedFields(row, null)).toEqual([]);
    expect(changedFields("text", ["list"])).toEqual([]);
  });

  it("never gives a value", () => {
    const said = JSON.stringify(
      changedFields({ title: "secret before" }, { title: "secret after" }),
    );
    expect(said).toBe('["title"]');
  });
});
