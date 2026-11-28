import { type FilterGroup, type Grant, roleGrants } from "@anygriddb/core";

export type FieldAccess = "hide" | "read" | "write";

/** A member's rules on a table, as they are kept. */
export type StoredRule = {
  rowFilter: FilterGroup | null;
  columns: ReadonlyArray<{
    column: string;
    access: FieldAccess;
    /** The rows, among the rule's, the field holds on (ADR 0145). */
    rows?: FilterGroup;
  }>;
};

/**
 * The members a table's rules are about: whoever may set them (who holds
 * `members.manage` there, by the base or the table) reads and changes
 * everything, and is never narrowed.
 */
export function ruledMembers<
  Person extends { baseRole: Grant | null; tableRole: Grant | null },
>(people: readonly Person[]): Person[] {
  return people.filter(
    (person) =>
      !roleGrants(person.baseRole, "members.manage") &&
      !roleGrants(person.tableRole, "members.manage"),
  );
}

/** Someone who reaches the table, as its access lists them. */
type Person = {
  userId: string;
  displayName: string;
  baseRole: Grant | null;
  tableRole: Grant | null;
  /** Their own role on the table, not a group's. */
  tableGiven: string | null;
  /** Whether their role on the base is their own, not a group's. */
  baseOwn: boolean;
};

/** A group given a role on the table, with the one it holds on the base. */
type Group = {
  groupId: string;
  displayName: string;
  members: number;
  baseRole: Grant | null;
  tableRole: Grant | null;
};

/** Whom a table's rules are about: a person, or a group (ADR 0131). */
export type RuleSubject =
  | ({ kind: "person"; key: string } & Person)
  | ({ kind: "group"; key: string } & Group);

/** The key a person's or a group's rules are listed by. */
export function subjectKey(subject: { userId: string } | { groupId: string }) {
  return "userId" in subject
    ? `person:${subject.userId}`
    : `group:${subject.groupId}`;
}

/**
 * Everyone a rule may be about, people first: those who manage the table
 * are left out (`ruledMembers`), and so is a group whose role manages it.
 */
export function ruleSubjects(
  people: readonly Person[],
  groups: readonly Group[],
): RuleSubject[] {
  return [
    ...ruledMembers(people).map((person) => ({
      ...person,
      kind: "person" as const,
      key: subjectKey(person),
    })),
    ...ruledMembers(groups).map((group) => ({
      ...group,
      kind: "group" as const,
      key: subjectKey(group),
    })),
  ];
}

/**
 * Whether a rule can narrow this person or group here (ADR 0131): a rule
 * narrows only the role it comes with, so they reach the table by a role
 * given on it alone, their own. A role on the base gives it whole: for a
 * person, their own or a group's; for a group, its own.
 */
export function narrowable(subject: RuleSubject): boolean {
  return subject.kind === "person"
    ? subject.baseRole === null && subject.tableGiven !== null
    : subject.baseRole === null;
}

/** What the server is told a rule is about. */
export function subjectInput(
  subject: RuleSubject,
): { userId: string } | { groupId: string } {
  return subject.kind === "person"
    ? { userId: subject.userId }
    : { groupId: subject.groupId };
}

/**
 * The person or group a list shows as chosen: the one chosen while the
 * list holds them, or its first. The list arrives after the panel is
 * drawn, and a panel that kept "nobody" from before it came sent its rules
 * to nobody.
 */
export function subjectShown(
  subjects: ReadonlyArray<{ key: string }>,
  chosen: string,
): string {
  return (
    subjects.find((subject) => subject.key === chosen)?.key ??
    subjects[0]?.key ??
    ""
  );
}

/**
 * What a member may do with each field, as their rule reads: with field
 * rules on the table, a field they do not name is hidden (one added since
 * stays hidden until a manager opens it); with none, every field is read
 * and written.
 */
export function storedAccess(
  stored: StoredRule | undefined,
  fields: readonly string[],
): Record<string, FieldAccess> {
  const named = new Map(
    (stored?.columns ?? []).map((rule) => [rule.column, rule.access]),
  );
  const unnamed: FieldAccess = named.size > 0 ? "hide" : "write";
  return Object.fromEntries(
    fields.map((field) => [field, named.get(field) ?? unnamed]),
  );
}

/** The fields a rule gives on some of its rows only, with those rows. */
export function storedFieldRows(
  stored: StoredRule | undefined,
): Record<string, FilterGroup> {
  return Object.fromEntries(
    (stored?.columns ?? []).flatMap((rule) =>
      rule.rows ? [[rule.column, rule.rows] as const] : [],
    ),
  );
}

/**
 * The rule to keep. No field rule at all while every field is read and
 * written on every row: a rule that names every field would hide the next
 * one added, which nobody asked. A hidden field holds on no row, so its
 * rows are dropped.
 */
export function ruleToSave(
  access: Readonly<Record<string, FieldAccess>>,
  rowFilter: FilterGroup | null,
  fieldRows: Readonly<Record<string, FilterGroup | null>> = {},
): { rowFilter: FilterGroup | null; columns: StoredRule["columns"] } {
  const entries = Object.entries(access);
  const rowsOf = (column: string, value: FieldAccess) =>
    value === "hide" ? null : (fieldRows[column] ?? null);
  return {
    rowFilter,
    columns: entries.every(
      ([column, value]) => value === "write" && !rowsOf(column, value),
    )
      ? []
      : entries.map(([column, value]) => {
          const rows = rowsOf(column, value);
          return rows
            ? { column, access: value, rows }
            : { column, access: value };
        }),
  };
}

/** Whether a rule keeps anything from its member. */
export function restricts(rule: {
  rowFilter: FilterGroup | null;
  columns: StoredRule["columns"];
}): boolean {
  return rule.rowFilter !== null || rule.columns.length > 0;
}
