import { describe, expect, it } from "vitest";
import {
  aclSubjectOf,
  clearTableAclInputSchema,
  setTableAclInputSchema,
} from "./acl";

const tableId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const groupId = "00000000-0000-4000-8000-000000000003";

describe("table rules input", () => {
  it("accepts field access and a row rule", () => {
    const parsed = setTableAclInputSchema.parse({
      tableId,
      userId,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "owner", op: "is", value: "me" }],
      },
      columns: [
        { column: "name", access: "write" },
        { column: "salary", access: "hide" },
        { column: "team", access: "read" },
      ],
    });
    expect(parsed.columns).toHaveLength(3);
  });

  it("refuses an unknown access, a bad field name, and extra keys", () => {
    for (const input of [
      {
        tableId,
        userId,
        rowFilter: null,
        columns: [{ column: "a", access: "all" }],
      },
      {
        tableId,
        userId,
        rowFilter: null,
        columns: [{ column: "A b", access: "read" }],
      },
      { tableId, userId, rowFilter: null, columns: [], extra: true },
    ]) {
      expect(setTableAclInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("takes a group in place of a person", () => {
    const parsed = setTableAclInputSchema.parse({
      tableId,
      groupId,
      rowFilter: null,
      columns: [{ column: "salary", access: "hide" }],
    });
    expect(aclSubjectOf(parsed)).toEqual({ groupId });
    expect(
      aclSubjectOf(clearTableAclInputSchema.parse({ tableId, userId })),
    ).toEqual({ userId });
  });

  it("refuses a rule about both a person and a group, or about nobody", () => {
    const rule = { tableId, rowFilter: null, columns: [] };
    for (const input of [{ ...rule, userId, groupId }, rule]) {
      expect(setTableAclInputSchema.safeParse(input).success).toBe(false);
    }
    expect(
      clearTableAclInputSchema.safeParse({ tableId, userId, groupId }).success,
    ).toBe(false);
    expect(clearTableAclInputSchema.safeParse({ tableId }).success).toBe(false);
  });
});
