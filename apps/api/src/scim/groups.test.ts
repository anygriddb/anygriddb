import { describe, expect, it } from "vitest";
import {
  createLocalGroupInputSchema,
  isLocalGroup,
  localGroupMemberInputSchema,
  updateLocalGroupInputSchema,
} from "./groups.js";

describe("isLocalGroup", () => {
  it("treats a null provider as local", () => {
    expect(isLocalGroup(null)).toBe(true);
  });

  it("treats a SCIM provider as provisioned", () => {
    expect(isLocalGroup("scim")).toBe(false);
  });
});

describe("createLocalGroupInputSchema", () => {
  it("takes a name and an optional description", () => {
    expect(
      createLocalGroupInputSchema.parse({
        displayName: "  Finance ",
        description: "  Controllers  ",
      }),
    ).toEqual({
      displayName: "Finance",
      description: "Controllers",
    });
    expect(createLocalGroupInputSchema.parse({ displayName: "Ops" })).toEqual({
      displayName: "Ops",
      description: undefined,
    });
  });

  it("turns an empty description into null and refuses a blank name", () => {
    expect(
      createLocalGroupInputSchema.parse({
        displayName: "Ops",
        description: "   ",
      }),
    ).toEqual({ displayName: "Ops", description: null });
    expect(
      createLocalGroupInputSchema.safeParse({ displayName: "  " }).success,
    ).toBe(false);
    expect(
      createLocalGroupInputSchema.safeParse({
        displayName: "Ops",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("updateLocalGroupInputSchema", () => {
  const groupId = "00000000-0000-4000-8000-000000000001";

  it("takes the group, a name, and an optional description", () => {
    expect(
      updateLocalGroupInputSchema.parse({
        groupId,
        displayName: "Finance",
        description: null,
      }),
    ).toEqual({ groupId, displayName: "Finance", description: null });
  });

  it("refuses a blank name or a text that is not an id", () => {
    expect(
      updateLocalGroupInputSchema.safeParse({
        groupId,
        displayName: " ",
      }).success,
    ).toBe(false);
    expect(
      updateLocalGroupInputSchema.safeParse({
        groupId: "not-a-uuid",
        displayName: "Finance",
      }).success,
    ).toBe(false);
  });
});

describe("localGroupMemberInputSchema", () => {
  const groupId = "00000000-0000-4000-8000-000000000001";
  const userId = "00000000-0000-4000-8000-000000000002";

  it("takes a group and an account", () => {
    expect(localGroupMemberInputSchema.parse({ groupId, userId })).toEqual({
      groupId,
      userId,
    });
  });

  it("refuses ids that are not uuids", () => {
    expect(
      localGroupMemberInputSchema.safeParse({
        groupId: "x",
        userId,
      }).success,
    ).toBe(false);
  });
});
