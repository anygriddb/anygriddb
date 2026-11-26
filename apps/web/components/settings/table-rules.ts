import { type FilterGroup, type Grant, roleGrants } from "@anygriddb/core";

export type FieldAccess = "hide" | "read" | "write";

/** A member's rules on a table, as they are kept. */
export type StoredRule = {
  rowFilter: FilterGroup | null;
  columns: ReadonlyArray<{ column: string; access: FieldAccess }>;
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

/**
 * Whether a rule can narrow this member here (ADR 0131): a rule narrows
 * only the role it comes with, so they reach the table by a role given on
 * it alone. A role on the base, their own or a group's, gives it whole.
 */
export function narrowable(person: {
  baseRole: Grant | null;
  tableRole: Grant | null;
}): boolean {
  return person.baseRole === null && person.tableRole !== null;
}

/**
 * The member a list shows as chosen: the one chosen while the list holds
 * them, or its first. The list arrives after the panel is drawn, and a
 * panel that kept "nobody" from before it came sent its rules to nobody.
 */
export function memberShown(
  people: ReadonlyArray<{ userId: string }>,
  chosen: string,
): string {
  return (
    people.find((person) => person.userId === chosen)?.userId ??
    people[0]?.userId ??
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

/**
 * The rule to keep. No field rule at all while every field is read and
 * written: a rule that names every field would hide the next one added,
 * which nobody asked. No row rule while it has no condition: it would
 * keep no row.
 */
export function ruleToSave(
  access: Readonly<Record<string, FieldAccess>>,
  rowFilter: FilterGroup | null,
): { rowFilter: FilterGroup | null; columns: StoredRule["columns"] } {
  const entries = Object.entries(access);
  return {
    rowFilter: rowFilter && rowFilter.conditions.length > 0 ? rowFilter : null,
    columns: entries.every(([, value]) => value === "write")
      ? []
      : entries.map(([column, value]) => ({ column, access: value })),
  };
}

/** Whether a rule keeps anything from its member. */
export function restricts(rule: {
  rowFilter: FilterGroup | null;
  columns: StoredRule["columns"];
}): boolean {
  return rule.rowFilter !== null || rule.columns.length > 0;
}
