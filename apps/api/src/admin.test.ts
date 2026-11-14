import { describe, expect, it } from "vitest";
import { createAccountInputSchema, updateAccountInputSchema } from "./admin.js";

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

describe("createAccountInputSchema", () => {
  const base = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";

  it("accepts a person, defaulting to no administration and no base", () => {
    expect(
      createAccountInputSchema.parse({
        email: "person@example.org",
        displayName: "Person",
      }),
    ).toEqual({
      email: "person@example.org",
      displayName: "Person",
      admin: false,
      memberships: [],
    });
    expect(
      createAccountInputSchema.parse({
        email: "person@example.org",
        displayName: "Person",
        memberships: [
          { baseId: base, role: "editor" },
          { baseId: other, role: "viewer" },
        ],
      }).memberships,
    ).toHaveLength(2);
  });

  it("refuses a bad address, no name, a base twice, too many, or an unknown role", () => {
    const parse = (input: object) =>
      createAccountInputSchema.safeParse({
        email: "person@example.org",
        displayName: "Person",
        ...input,
      }).success;
    expect(parse({ email: "not-an-email" })).toBe(false);
    expect(parse({ displayName: undefined })).toBe(false);
    expect(
      parse({
        memberships: [
          { baseId: base, role: "editor" },
          { baseId: base, role: "viewer" },
        ],
      }),
    ).toBe(false);
    expect(
      parse({
        memberships: Array.from({ length: 21 }, (_, index) => ({
          baseId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          role: "viewer",
        })),
      }),
    ).toBe(false);
    expect(parse({ memberships: [{ baseId: base, role: "root" }] })).toBe(
      false,
    );
    expect(parse({ isAdmin: true })).toBe(false);
  });
});
