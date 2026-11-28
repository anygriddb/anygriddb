import { ceilingOf } from "./limits";
import { z } from "zod";
import { isIsoDate } from "./iso-date";
import type { ValueKind } from "./field-types";
import { columnNameSchema } from "./names";

const FILTER_OPERATORS = [
  "is",
  "is_not",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_any_of",
  "is_none_of",
  "has_any_of",
  "has_all_of",
  "has_none_of",
  "is_exactly",
  "is_before",
  "is_after",
  "is_on_or_before",
  "is_on_or_after",
  "is_within",
  // `[from, to]`, both ends included; a blank end leaves that side open.
  "is_between",
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** Single-day and calendar-period modes for is / is_before / is_after… */
export const DATE_MODES = [
  "today",
  "yesterday",
  "tomorrow",
  "days_ago",
  "days_from_now",
  "this_week",
  "last_week",
  "next_week",
  "this_month",
  "last_month",
  "next_month",
  "this_year",
  "last_year",
  "next_year",
  "exact",
] as const;

/** Rolling windows for is_within. */
export const WITHIN_MODES = [
  "past_week",
  "past_month",
  "past_year",
  "next_week",
  "next_month",
  "next_year",
  "past_days",
  "next_days",
  "this_week",
  "this_month",
  "this_year",
] as const;

export type DateMode = (typeof DATE_MODES)[number];
export type WithinMode = (typeof WITHIN_MODES)[number];

type CalendarUnit = "week" | "month" | "year";

/**
 * The calendar periods a date condition names: a unit, and how many of it
 * away from the present one. A filter is read in two places, the database
 * (`query/filter-sql.ts`) and the application (`filter-eval.ts`): both
 * take a name's meaning from here.
 */
const CALENDAR_PERIODS: Partial<
  Record<DateMode | WithinMode, readonly [CalendarUnit, number]>
> = {
  this_week: ["week", 0],
  last_week: ["week", -1],
  next_week: ["week", 1],
  this_month: ["month", 0],
  last_month: ["month", -1],
  next_month: ["month", 1],
  this_year: ["year", 0],
  last_year: ["year", -1],
  next_year: ["year", 1],
};

/** The calendar period `mode` names, when it names one. */
export function calendarPeriod(
  mode: DateMode | WithinMode,
): readonly [CalendarUnit, number] | undefined {
  return CALENDAR_PERIODS[mode];
}

const dateFilterValueSchema = z
  .object({
    mode: z.enum([...new Set([...DATE_MODES, ...WITHIN_MODES])] as [
      DateMode | WithinMode,
      ...(DateMode | WithinMode)[],
    ]),
    days: z.int().min(0).max(36_500).optional(),
    date: z.string().refine(isIsoDate).optional(),
  })
  .strict();

export type DateFilterValue = z.infer<typeof dateFilterValueSchema>;

/** An attribute's key (ADR 0142): what a catalogue of the instance names. */
export const attributeKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

/**
 * A condition's value that is the reader's own (ADR 0142): their values of
 * an attribute of the instance, such as their ward.
 */
const attributeFilterValueSchema = z
  .object({ attribute: attributeKeySchema })
  .strict();

const filterValueSchema = z.union([
  z.string().max(4_000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(200)).max(100),
  dateFilterValueSchema,
  attributeFilterValueSchema,
]);

export type FilterValue = z.infer<typeof filterValueSchema>;

/** The attribute a condition's value names, if it names one (ADR 0142). */
export function attributeOf(
  value: FilterValue | undefined,
): string | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "attribute" in value
    ? value.attribute
    : undefined;
}

/**
 * The operators a condition naming an attribute takes: those that keep
 * rows, so that a reader without a value keeps none, never every row.
 */
export const ATTRIBUTE_OPERATORS: ReadonlySet<FilterOperator> = new Set([
  "is",
  "is_any_of",
  "has_any_of",
]);

/**
 * A rule as one reader reads it (ADR 0142): each condition naming an
 * attribute becomes one over the reader's values of it (`is any of`, or
 * `has any of` for a multiple select). One the reader holds no value of
 * is left as written, and keeps no row.
 */
export function resolveAttributes(
  group: FilterGroup,
  values: (key: string) => readonly string[] | undefined,
): FilterGroup {
  return {
    conjunction: group.conjunction,
    conditions: group.conditions.map((node) => {
      if ("conditions" in node) return resolveAttributes(node, values);
      const key = attributeOf(node.value);
      const held = key === undefined ? undefined : values(key);
      if (!held || held.length === 0) return node;
      return {
        column: node.column,
        op: node.op === "has_any_of" ? "has_any_of" : "is_any_of",
        value: [...held],
      };
    }),
  };
}

/** The attributes a filter names, each once. */
export function filterAttributes(group: FilterGroup): string[] {
  const found = new Set<string>();
  const visit = (node: FilterGroup | FilterCondition) => {
    if ("conditions" in node) node.conditions.forEach(visit);
    else {
      const key = attributeOf(node.value);
      if (key !== undefined) found.add(key);
    }
  };
  visit(group);
  return [...found];
}

const filterConditionSchema = z
  .object({
    column: columnNameSchema,
    op: z.enum(FILTER_OPERATORS),
    value: filterValueSchema.optional(),
  })
  .strict();

export type FilterCondition = z.infer<typeof filterConditionSchema>;

export type FilterGroup = {
  conjunction: "and" | "or";
  conditions: Array<FilterCondition | FilterGroup>;
};

export const MAX_FILTER_DEPTH = ceilingOf("filter.depth");
export const MAX_FILTER_CONDITIONS = ceilingOf("filter.conditions");

const groupNode: z.ZodType<FilterGroup> = z.lazy(() =>
  z
    .object({
      conjunction: z.enum(["and", "or"]),
      conditions: z
        .array(z.union([filterConditionSchema, groupNode]))
        .max(MAX_FILTER_CONDITIONS),
    })
    .strict(),
);

export function isFilterGroup(
  node: FilterCondition | FilterGroup,
): node is FilterGroup {
  return "conjunction" in node;
}

/** Recursive and/or filter tree: five levels and a hundred conditions at most. */
export const filterGroupSchema: z.ZodType<FilterGroup> = groupNode.superRefine(
  (group, context) => {
    let count = 0;
    const visit = (node: FilterGroup, depth: number): void => {
      if (depth > MAX_FILTER_DEPTH) {
        context.addIssue({ code: "custom", message: "Invalid filter" });
        return;
      }
      for (const child of node.conditions) {
        if (isFilterGroup(child)) {
          visit(child, depth + 1);
        } else {
          count += 1;
        }
      }
    };
    visit(group, 1);
    if (count > MAX_FILTER_CONDITIONS) {
      context.addIssue({ code: "custom", message: "Invalid filter" });
    }
  },
);

/** The fields a filter names, at any depth. */
export function filterColumnNames(group: FilterGroup): string[] {
  return group.conditions.flatMap((node) =>
    isFilterGroup(node) ? filterColumnNames(node) : [node.column],
  );
}

/**
 * Whether a condition still waits for its value, as one just added does:
 * none, an empty text or list, a range with neither end, an exact day not
 * chosen. An operator that takes no value (is empty) waits for none.
 */
export function awaitsValue(condition: FilterCondition): boolean {
  if (condition.op === "is_empty" || condition.op === "is_not_empty") {
    return false;
  }
  const { value } = condition;
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.every((item) => item === "");
  if (typeof value === "object") {
    // The reader's attribute is a value, which they may hold or not.
    if ("attribute" in value) return false;
    return value.mode === "exact" && !value.date;
  }
  return false;
}

/**
 * What keeps a filter from being read as it was written, where a condition
 * left out would let through rows it was set to hold back (a row rule, an
 * automation's condition): a group without a condition, or the first
 * condition still waiting for its value.
 */
export function filterGap(
  group: FilterGroup,
): { kind: "empty" } | { kind: "blank"; column: string } | null {
  if (group.conditions.length === 0) return { kind: "empty" };
  for (const node of group.conditions) {
    if (isFilterGroup(node)) {
      const gap = filterGap(node);
      if (gap) return gap;
    } else if (awaitsValue(node)) {
      return { kind: "blank", column: node.column };
    }
  }
  return null;
}

/**
 * A filter with only the conditions on fields `keep` accepts. A nested
 * group left with none goes; the group itself stays, even empty.
 */
export function filterKeeping(
  group: FilterGroup,
  keep: (column: string) => boolean,
): FilterGroup {
  const conditions: FilterGroup["conditions"] = [];
  for (const node of group.conditions) {
    if (isFilterGroup(node)) {
      const inner = filterKeeping(node, keep);
      if (inner.conditions.length > 0) conditions.push(inner);
    } else if (keep(node.column)) {
      conditions.push(node);
    }
  }
  return { ...group, conditions };
}

/** The pre-tree flat filter, still accepted from stored views and old clients. */
export const legacyFilterSchema = z.object({
  column: columnNameSchema,
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
  value: z.union([z.string().max(20_000), z.number(), z.boolean()]),
});

type LegacyFilter = z.infer<typeof legacyFilterSchema>;

const LEGACY_OPS: Record<LegacyFilter["op"], FilterOperator> = {
  eq: "is",
  neq: "is_not",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  contains: "contains",
};

export function legacyFiltersToGroup(
  filters: readonly LegacyFilter[],
): FilterGroup {
  return {
    conjunction: "and",
    conditions: filters.map((filter) => ({
      column: filter.column,
      op: LEGACY_OPS[filter.op],
      value: filter.value,
    })),
  };
}

/** Combines filters with AND, dropping empty ones. */
export function andFilters(
  ...groups: Array<FilterGroup | undefined>
): FilterGroup | undefined {
  const present = groups.filter(
    (group): group is FilterGroup =>
      group !== undefined && group.conditions.length > 0,
  );
  if (present.length === 0) {
    return undefined;
  }
  if (present.length === 1) {
    return present[0];
  }
  return { conjunction: "and", conditions: present };
}

export type FilterKind = ValueKind | "array";

const TEXT_OPS: FilterOperator[] = [
  "is",
  "is_not",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_any_of",
  "is_none_of",
  "is_empty",
  "is_not_empty",
];
const NUMBER_OPS: FilterOperator[] = [
  "is",
  "is_not",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_between",
  "is_empty",
  "is_not_empty",
];
const DATE_OPS: FilterOperator[] = [
  "is",
  "is_not",
  "is_before",
  "is_after",
  "is_on_or_before",
  "is_on_or_after",
  "is_within",
  "is_between",
  "is_empty",
  "is_not_empty",
];
const SET_OPS: FilterOperator[] = [
  "has_any_of",
  "has_all_of",
  "has_none_of",
  "is_exactly",
  "is_empty",
  "is_not_empty",
];

export const OPERATORS_BY_KIND: Record<FilterKind, readonly FilterOperator[]> =
  {
    text: TEXT_OPS,
    number: NUMBER_OPS,
    boolean: ["is"],
    date: DATE_OPS,
    datetime: DATE_OPS,
    options: [...SET_OPS, "contains", "not_contains"],
    users: SET_OPS,
    user: [
      "is",
      "is_not",
      "is_any_of",
      "is_none_of",
      "is_empty",
      "is_not_empty",
    ],
    files: ["is_empty", "is_not_empty"],
    links: [
      "has_any_of",
      "has_none_of",
      "contains",
      "not_contains",
      "is_empty",
      "is_not_empty",
    ],
    array: [
      "contains",
      "not_contains",
      "has_any_of",
      "has_none_of",
      "is_empty",
      "is_not_empty",
    ],
  };

export function filterOperatorsFor(
  kind: FilterKind,
): readonly FilterOperator[] {
  return OPERATORS_BY_KIND[kind];
}
