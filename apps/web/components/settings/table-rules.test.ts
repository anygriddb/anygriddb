import type { Role } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  memberShown,
  restricts,
  narrowable,
  ruledMembers,
  ruleToSave,
  storedAccess,
} from "./table-rules";

const own = {
  conjunction: "and" as const,
  conditions: [{ column: "seller", op: "is" as const, value: "ada" }],
};

describe("ruledMembers", () => {
  const people: Array<{
    name: string;
    baseRole: Role | null;
    tableRole: Role | null;
  }> = [
    { name: "owner of the base", baseRole: "owner", tableRole: null },
    { name: "editor of the base", baseRole: "editor", tableRole: null },
    { name: "viewer here too", baseRole: "editor", tableRole: "viewer" },
    { name: "owner of the table", baseRole: null, tableRole: "owner" },
    { name: "of the table only", baseRole: null, tableRole: "commenter" },
  ];

  it("leaves out whoever manages the table, by the base or the table", () => {
    expect(ruledMembers(people).map((person) => person.name)).toEqual([
      "editor of the base",
      "viewer here too",
      "of the table only",
    ]);
  });

  it("narrows only those who reach the table by a role on it alone", () => {
    expect(
      ruledMembers(people)
        .filter(narrowable)
        .map((person) => person.name),
    ).toEqual(["of the table only"]);
  });
});

describe("memberShown", () => {
  const people = [{ userId: "ada" }, { userId: "bob" }];

  it("is the member chosen while the list holds them", () => {
    expect(memberShown(people, "bob")).toBe("bob");
  });

  it("is the list's first while nobody is chosen, or someone who left", () => {
    expect(memberShown(people, "")).toBe("ada");
    expect(memberShown(people, "gone")).toBe("ada");
  });

  it("is nobody while the list is empty", () => {
    expect(memberShown([], "ada")).toBe("");
  });
});

describe("storedAccess", () => {
  const fields = ["name", "price", "margin"];

  it("reads and writes every field while the member has no field rule", () => {
    expect(storedAccess(undefined, fields)).toEqual({
      name: "write",
      price: "write",
      margin: "write",
    });
    expect(storedAccess({ rowFilter: own, columns: [] }, fields)).toEqual({
      name: "write",
      price: "write",
      margin: "write",
    });
  });

  it("hides a field the member's rules do not name: one added since", () => {
    expect(
      storedAccess(
        {
          rowFilter: null,
          columns: [
            { column: "name", access: "write" },
            { column: "price", access: "read" },
          ],
        },
        fields,
      ),
    ).toEqual({ name: "write", price: "read", margin: "hide" });
  });
});

describe("ruleToSave", () => {
  it("keeps no field rule while every field is read and written", () => {
    expect(ruleToSave({ name: "write", price: "write" }, own)).toEqual({
      rowFilter: own,
      columns: [],
    });
  });

  it("names every field once one is restricted", () => {
    expect(ruleToSave({ name: "write", price: "hide" }, null)).toEqual({
      rowFilter: null,
      columns: [
        { column: "name", access: "write" },
        { column: "price", access: "hide" },
      ],
    });
  });
});

describe("restricts", () => {
  it("says whether a rule keeps anything from its member", () => {
    expect(restricts({ rowFilter: null, columns: [] })).toBe(false);
    expect(restricts({ rowFilter: own, columns: [] })).toBe(true);
    expect(
      restricts({
        rowFilter: null,
        columns: [{ column: "price", access: "read" }],
      }),
    ).toBe(true);
  });
});
