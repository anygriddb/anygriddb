import type { Role } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  narrowable,
  restricts,
  ruledMembers,
  ruleSubjects,
  ruleToSave,
  storedAccess,
  storedFieldRows,
  subjectInput,
  subjectKey,
  subjectShown,
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
});

describe("ruleSubjects", () => {
  const person = (
    userId: string,
    baseRole: Role | null,
    tableGiven: Role | null,
    tableRole: Role | null = tableGiven,
  ) => ({
    userId,
    displayName: userId,
    baseRole,
    tableRole,
    tableGiven,
    baseOwn: baseRole !== null,
  });
  const group = (groupId: string, baseRole: Role | null, tableRole: Role) => ({
    groupId,
    displayName: groupId,
    members: 2,
    baseRole,
    tableRole,
  });
  const subjects = ruleSubjects(
    [
      person("ada", null, "commenter"),
      person("bob", "editor", null),
      // Reaches the table through a group's role on it alone.
      person("cleo", null, null, "viewer"),
      person("dan", null, "owner"),
    ],
    [
      group("nurses", null, "editor"),
      group("leads", "viewer", "editor"),
      group("heads", null, "owner"),
    ],
  );

  it("lists people, then groups, by keys of their own, managers left out", () => {
    expect(subjects.map((subject) => subject.key)).toEqual([
      "person:ada",
      "person:bob",
      "person:cleo",
      "group:nurses",
      "group:leads",
    ]);
  });

  it("narrows a person by their own role on the table, a group by its own", () => {
    expect(subjects.filter(narrowable).map((subject) => subject.key)).toEqual([
      "person:ada",
      "group:nurses",
    ]);
  });

  it("tells the server whom the rule is about, and nothing else", () => {
    const [ada] = subjects;
    const nurses = subjects.find((subject) => subject.kind === "group");
    expect(ada && subjectInput(ada)).toEqual({ userId: "ada" });
    expect(nurses && subjectInput(nurses)).toEqual({ groupId: "nurses" });
    expect(subjectKey({ groupId: "nurses" })).toBe("group:nurses");
  });
});

describe("subjectShown", () => {
  const subjects = [{ key: "person:ada" }, { key: "group:bob" }];

  it("is the one chosen while the list holds them", () => {
    expect(subjectShown(subjects, "group:bob")).toBe("group:bob");
  });

  it("is the list's first while nobody is chosen, or someone who left", () => {
    expect(subjectShown(subjects, "")).toBe("person:ada");
    expect(subjectShown(subjects, "person:gone")).toBe("person:ada");
  });

  it("is nobody while the list is empty", () => {
    expect(subjectShown([], "person:ada")).toBe("");
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

  it("names every field once one holds on some rows, hidden ones on none", () => {
    expect(
      ruleToSave({ name: "write", price: "read", notes: "hide" }, null, {
        price: own,
        notes: own,
        name: null,
      }),
    ).toEqual({
      rowFilter: null,
      columns: [
        { column: "name", access: "write" },
        { column: "price", access: "read", rows: own },
        { column: "notes", access: "hide" },
      ],
    });
    expect(
      storedFieldRows({
        rowFilter: null,
        columns: [
          { column: "price", access: "read", rows: own },
          { column: "name", access: "write" },
        ],
      }),
    ).toEqual({ price: own });
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
