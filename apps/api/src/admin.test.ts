import { describe, expect, it } from "vitest";
import { changedKeys, updateAccountInputSchema } from "./admin.js";

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

describe("updateAccountInputSchema", () => {
  const userId = "00000000-0000-4000-8000-000000000001";

  it("takes a name and an address, and trims the name", () => {
    expect(
      updateAccountInputSchema.parse({
        userId,
        displayName: "  Ada Lovelace ",
        email: "ada@example.org",
      }),
    ).toEqual({
      userId,
      displayName: "Ada Lovelace",
      email: "ada@example.org",
    });
  });

  it("refuses an empty name, a text that is not an address, and a field it does not know", () => {
    const refused = (input: object) =>
      updateAccountInputSchema.safeParse({
        userId,
        displayName: "Ada",
        email: "ada@example.org",
        ...input,
      }).success;
    expect(refused({ displayName: "   " })).toBe(false);
    expect(refused({ email: "ada" })).toBe(false);
    expect(refused({ isAdmin: true })).toBe(false);
  });
});
