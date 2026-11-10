import { z } from "zod";
import { isIsoDate } from "./cell-values";
import type { ValueKind } from "./field-types";
import { columnNameSchema } from "./names";

export const FILTER_OPERATORS = [
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

export const dateFilterValueSchema = z
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

export const filterValueSchema = z.union([
  z.string().max(4_000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(200)).max(100),
  dateFilterValueSchema,
]);

export type FilterValue = z.infer<typeof filterValueSchema>;

export const filterConditionSchema = z
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

export const MAX_FILTER_DEPTH = 5;
export const MAX_FILTER_CONDITIONS = 100;

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

/** The pre-tree flat filter, still accepted from stored views and old clients. */
export const legacyFilterSchema = z.object({
  column: columnNameSchema,
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
  value: z.union([z.string().max(20_000), z.number(), z.boolean()]),
});

export type LegacyFilter = z.infer<typeof legacyFilterSchema>;

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
