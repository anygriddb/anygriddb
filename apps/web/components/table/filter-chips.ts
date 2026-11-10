import {
  isFilterGroup,
  type FilterCondition,
  type FilterGroup,
} from "@anygriddb/core";

/**
 * What the bar under the toolbar shows of a view's filter: one chip per
 * condition at the top of the tree, one per group below it, and the word
 * that joins them. A nested group stays whole, so an OR never reads as an
 * AND.
 */
export type FilterChip =
  | { kind: "condition"; index: number; condition: FilterCondition }
  | { kind: "group"; index: number; count: number };

function leaves(group: FilterGroup): number {
  return group.conditions.reduce(
    (count, node) => count + (isFilterGroup(node) ? leaves(node) : 1),
    0,
  );
}

export function filterChips(group: FilterGroup | undefined | null): {
  conjunction: FilterGroup["conjunction"];
  chips: FilterChip[];
} {
  if (!group) return { conjunction: "and", chips: [] };
  return {
    conjunction: group.conjunction,
    chips: group.conditions.map((node, index): FilterChip =>
      isFilterGroup(node)
        ? { kind: "group", index, count: leaves(node) }
        : { kind: "condition", index, condition: node },
    ),
  };
}

/** The filter without the top-level node at `index`; null once empty. */
export function withoutChip(
  group: FilterGroup | undefined | null,
  index: number,
): FilterGroup | null {
  if (!group) return null;
  const conditions = group.conditions.filter((_, at) => at !== index);
  return conditions.length > 0
    ? { conjunction: group.conjunction, conditions }
    : null;
}

/** Words the chip's value is said with, in the reader's language. */
export type ChipWords = {
  me: string;
  checked: string;
  unchecked: string;
  /** A date period by its mode, `N` standing for its days. */
  period: (mode: string) => string;
  /** A person's name by id, or undefined when unknown. */
  person: (id: string) => string | undefined;
};

/** A condition's value as a person reads it: names, periods, not ids. */
export function chipValueText(
  value: FilterCondition["value"],
  words: ChipWords,
): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "boolean")
    return value ? words.checked : words.unchecked;
  if (Array.isArray(value)) {
    return value
      .map((item) => (item === "me" ? words.me : (words.person(item) ?? item)))
      .join(", ");
  }
  if (typeof value === "object") {
    if (value.mode === "exact") return value.date ?? "";
    return words.period(value.mode).replace("N", String(value.days ?? ""));
  }
  if (value === "me") return words.me;
  return String(value);
}
