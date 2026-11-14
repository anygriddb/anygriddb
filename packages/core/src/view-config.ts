import { z } from "zod";
import { optionColorSchema } from "./field-config";
import {
  andFilters,
  filterGroupSchema,
  legacyFilterSchema,
  legacyFiltersToGroup,
  type FilterGroup,
} from "./filter";
import { columnNameSchema } from "./names";
import { AGGREGATE_FNS, groupSpecSchema, rowSortSchema } from "./query/read";

const VIEW_TYPES = [
  "grid",
  "form",
  "kanban",
  "gallery",
  "calendar",
  "timeline",
  "map",
] as const;

export type ViewType = (typeof VIEW_TYPES)[number];

export const viewTypeSchema = z.enum(VIEW_TYPES);

const ROW_HEIGHTS = ["short", "medium", "tall", "extra"] as const;

/** Soft product ceilings for view chrome (UI + schema stay in lockstep). */
export const MAX_VIEW_SORTS = 10;
export const MAX_VIEW_GROUPS = 5;
export const MAX_FROZEN_COLUMNS = 10;

const columnList = z.array(columnNameSchema).max(200);

const formFieldSchema = z
  .object({
    column: columnNameSchema,
    label: z.string().trim().max(200).optional(),
    description: z.string().trim().max(1_000).optional(),
    required: z.boolean().optional(),
    hidden: z.boolean().optional(),
    showIf: filterGroupSchema.optional(),
  })
  .strict();

const formConfigSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    description: z.string().trim().max(4_000).optional(),
    submitLabel: z.string().trim().max(60).optional(),
    successMessage: z.string().trim().max(1_000).optional(),
    redirectUrl: z
      .url({ protocol: /^https$/ })
      .max(2_000)
      .optional(),
    allowAnother: z.boolean().optional(),
    fields: z.array(formFieldSchema).max(200).optional(),
  })
  .strict();

type FormConfig = z.infer<typeof formConfigSchema>;

type FormFieldConfig = NonNullable<FormConfig["fields"]>[number];

/**
 * A form's fields once the table's own rules apply: a field the table
 * requires is always on the form, always required, and never behind a
 * condition, wherever the form placed it. A form that lists no fields
 * shows every one it may (`names`).
 */
export function withRequiredFormFields(
  fields: readonly FormFieldConfig[] | undefined,
  names: readonly string[],
  required: readonly string[],
): FormFieldConfig[] {
  const listed: FormFieldConfig[] =
    fields && fields.length > 0
      ? [...fields]
      : names.map((column) => ({ column }));
  if (required.length === 0) return listed;
  const needed = new Set(required);
  const out = listed.map((field) => {
    if (!needed.has(field.column)) return field;
    const next: FormFieldConfig = { ...field, required: true };
    delete next.showIf;
    delete next.hidden;
    return next;
  });
  for (const column of required) {
    if (!out.some((field) => field.column === column)) {
      out.push({ column, required: true });
    }
  }
  return out;
}

const colorRuleSchema = z
  .object({ filter: filterGroupSchema, color: optionColorSchema })
  .strict();

const viewColorSchema = z
  .object({
    mode: z.enum(["none", "select", "rules"]),
    column: columnNameSchema.optional(),
    rules: z.array(colorRuleSchema).max(20).optional(),
  })
  .strict();

const shape = {
  filter: filterGroupSchema,
  filtersDisabled: z.boolean(),
  sort: z.array(rowSortSchema).max(MAX_VIEW_SORTS),
  groupBy: z.array(groupSpecSchema).max(MAX_VIEW_GROUPS),
  search: z.string().trim().min(1).max(200),
  fieldOrder: columnList,
  hiddenFields: columnList,
  columnWidths: z.record(columnNameSchema, z.int().min(40).max(1_200)),
  frozenColumns: z.int().min(0).max(MAX_FROZEN_COLUMNS),
  rowHeight: z.enum(ROW_HEIGHTS),
  aggregations: z.record(columnNameSchema, z.enum(AGGREGATE_FNS)),
  color: viewColorSchema,
  stackColumn: columnNameSchema,
  hideEmptyStacks: z.boolean(),
  coverColumn: columnNameSchema,
  coverFit: z.enum(["cover", "contain"]),
  titleColumn: columnNameSchema,
  cardFields: columnList,
  startColumn: columnNameSchema,
  endColumn: columnNameSchema,
  colorColumn: columnNameSchema,
  timelineScale: z.enum(["day", "week", "month"]),
  /** Kanban stacks shown folded, by option name; "" for rows without one. */
  collapsedStacks: z.array(z.string().max(80)).max(201),
  /** What the view is for, shown above it. */
  description: z.string().trim().min(1).max(1_000),
  latitudeColumn: columnNameSchema,
  longitudeColumn: columnNameSchema,
  form: formConfigSchema,
};

type Shape = typeof shape;

export type ViewConfig = { [K in keyof Shape]?: z.infer<Shape[K]> };

const partialShape = Object.fromEntries(
  Object.entries(shape).map(([key, value]) => [key, value.optional()]),
) as { [K in keyof Shape]: z.ZodOptional<Shape[K]> };

const nullableShape = Object.fromEntries(
  Object.entries(shape).map(([key, value]) => [
    key,
    value.nullable().optional(),
  ]),
) as { [K in keyof Shape]: z.ZodOptional<z.ZodNullable<Shape[K]>> };

export const viewConfigSchema: z.ZodType<ViewConfig> = z
  .object(partialShape)
  .strict();

/** A partial update: present keys replace, `null` removes. */
export const viewConfigPatchSchema = z.object(nullableShape).strict();

export type ViewConfigPatch = z.infer<typeof viewConfigPatchSchema>;

const legacySchema = z
  .object({
    filters: z.array(legacyFilterSchema).max(50).optional(),
    hiddenColumns: columnList.optional(),
    groupColumn: columnNameSchema.optional(),
    dateColumn: columnNameSchema.optional(),
  })
  .loose();

/**
 * Reads a stored view configuration. Keys from before the v2 views
 * (`filters`, `hiddenColumns`, `groupColumn`, `dateColumn`) are mapped to
 * their new names; unknown keys and invalid values are dropped.
 */
export function normalizeViewConfig(
  raw: unknown,
  viewType?: ViewType,
): ViewConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const legacy = legacySchema.safeParse(raw);
  const source: Record<string, unknown> = {
    ...(raw as Record<string, unknown>),
  };
  if (legacy.success) {
    const { filters, hiddenColumns, groupColumn, dateColumn } = legacy.data;
    delete source.filters;
    delete source.hiddenColumns;
    delete source.groupColumn;
    delete source.dateColumn;
    if (filters && filters.length > 0) {
      const current = filterGroupSchema.safeParse(source.filter);
      source.filter = andFilters(
        current.success ? current.data : undefined,
        legacyFiltersToGroup(filters),
      );
    }
    if (hiddenColumns && source.hiddenFields === undefined) {
      source.hiddenFields = hiddenColumns;
    }
    if (groupColumn && source.stackColumn === undefined) {
      source.stackColumn = groupColumn;
      if (viewType === "grid" && source.groupBy === undefined) {
        source.groupBy = [{ column: groupColumn, direction: "asc" }];
      }
    }
    if (dateColumn && source.startColumn === undefined) {
      source.startColumn = dateColumn;
    }
  }
  const config: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    if (source[key] === undefined) {
      continue;
    }
    const parsed = (schema as z.ZodType).safeParse(source[key]);
    if (parsed.success) {
      config[key] = parsed.data;
    }
  }
  return config;
}

export function applyViewConfigPatch(
  current: ViewConfig,
  patch: ViewConfigPatch,
): ViewConfig {
  const next: Record<string, unknown> = { ...current };
  // The patch type is cast from the schema; `null` removes a key.
  for (const [key, value] of Object.entries(patch) as Array<
    [string, unknown]
  >) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      Reflect.deleteProperty(next, key);
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** Filter a view applies, honouring `filtersDisabled`. */
export function viewFilter(config: ViewConfig): FilterGroup | undefined {
  return config.filtersDisabled ? undefined : config.filter;
}

/** Column names a view config references, for validating against the catalog. */
export function viewConfigColumns(config: ViewConfig): string[] {
  const names = new Set<string>();
  const add = (name: string | undefined): void => {
    if (name) names.add(name);
  };
  const addFilter = (group: FilterGroup | undefined): void => {
    for (const node of group?.conditions ?? []) {
      if ("conjunction" in node) {
        addFilter(node);
      } else {
        names.add(node.column);
      }
    }
  };
  addFilter(config.filter);
  for (const sort of config.sort ?? []) add(sort.column);
  for (const group of config.groupBy ?? []) add(group.column);
  for (const rule of config.color?.rules ?? []) addFilter(rule.filter);
  add(config.color?.column);
  for (const name of [
    config.stackColumn,
    config.coverColumn,
    config.titleColumn,
    config.startColumn,
    config.endColumn,
    config.colorColumn,
    config.latitudeColumn,
    config.longitudeColumn,
  ]) {
    add(name);
  }
  for (const name of config.cardFields ?? []) add(name);
  for (const field of config.form?.fields ?? []) {
    add(field.column);
    addFilter(field.showIf);
  }
  return [...names];
}

function stripFilter(
  group: FilterGroup | undefined,
  name: string,
): FilterGroup | undefined {
  if (!group) {
    return undefined;
  }
  const conditions: FilterGroup["conditions"] = [];
  for (const node of group.conditions) {
    if ("conjunction" in node) {
      const inner = stripFilter(node, name);
      if (inner && inner.conditions.length > 0) {
        conditions.push(inner);
      }
    } else if (node.column !== name) {
      conditions.push(node);
    }
  }
  return { ...group, conditions };
}

/** Removes every reference to a deleted column from a view configuration. */
export function stripColumnFromConfig(
  config: ViewConfig,
  name: string,
): ViewConfig {
  const next: ViewConfig = { ...config };
  next.filter = stripFilter(config.filter, name);
  if (next.filter && next.filter.conditions.length === 0) delete next.filter;
  // A group that holds one group alone reads as that group.
  const only =
    next.filter?.conditions.length === 1 && next.filter.conditions[0];
  if (only && "conjunction" in only) next.filter = only;
  if (config.sort)
    next.sort = config.sort.filter((sort) => sort.column !== name);
  if (config.groupBy)
    next.groupBy = config.groupBy.filter((group) => group.column !== name);
  if (config.fieldOrder)
    next.fieldOrder = config.fieldOrder.filter((item) => item !== name);
  if (config.hiddenFields)
    next.hiddenFields = config.hiddenFields.filter((item) => item !== name);
  if (config.cardFields)
    next.cardFields = config.cardFields.filter((item) => item !== name);
  if (config.columnWidths) {
    next.columnWidths = Object.fromEntries(
      Object.entries(config.columnWidths).filter(([key]) => key !== name),
    );
  }
  if (config.aggregations) {
    next.aggregations = Object.fromEntries(
      Object.entries(config.aggregations).filter(([key]) => key !== name),
    );
  }
  if (config.color) {
    next.color = {
      ...config.color,
      ...(config.color.column === name
        ? { column: undefined, mode: "none" as const }
        : {}),
      rules: config.color.rules
        ?.map((rule) => ({ ...rule, filter: stripFilter(rule.filter, name) }))
        .filter(
          (rule): rule is { filter: FilterGroup; color: typeof rule.color } =>
            Boolean(rule.filter?.conditions.length),
        ),
    };
  }
  for (const key of [
    "stackColumn",
    "coverColumn",
    "titleColumn",
    "startColumn",
    "endColumn",
    "colorColumn",
    "latitudeColumn",
    "longitudeColumn",
  ] as const) {
    if (next[key] === name) Reflect.deleteProperty(next, key);
  }
  if (config.form?.fields) {
    next.form = {
      ...config.form,
      fields: config.form.fields
        .filter((field) => field.column !== name)
        .map((field) => ({
          ...field,
          showIf: stripFilter(field.showIf, name),
        })),
    };
  }
  return normalizeViewConfig(next);
}

/**
 * Drops references to columns a view can no longer see, such as fields
 * in the trash. The stored config keeps them, so a restored field comes
 * back in its views.
 */
export function pruneViewConfig(
  config: ViewConfig,
  known: ReadonlySet<string>,
): ViewConfig {
  const referenced = new Set([
    ...viewConfigColumns(config),
    ...(config.fieldOrder ?? []),
    ...(config.hiddenFields ?? []),
    ...Object.keys(config.columnWidths ?? {}),
    ...Object.keys(config.aggregations ?? {}),
  ]);
  let next = config;
  for (const name of referenced) {
    if (!known.has(name)) next = stripColumnFromConfig(next, name);
  }
  return next;
}

/**
 * Puts back, in `next`, what `stored` said of fields in the trash, for
 * the settings in `keys`. A person sees a view without those fields and
 * saves what they see: without this, a field restored later would come
 * back at the end of the view, shown, unsorted, and out of its form.
 *
 * Lists keep the place each field had, after the item it followed. A
 * filter keeps the conditions on such a field that applied to every row
 * (those of a top-level "and"); a nested condition, a color rule, or a
 * form field's condition is not put back. A setting that names one field
 * (the stack, the cover…) is what the person chose.
 */
export function keepTrashedParts(
  stored: ViewConfig,
  next: ViewConfig,
  trashed: ReadonlySet<string>,
  /** The settings saved; "all" when the whole configuration was. */
  keys: Iterable<string> | "all",
): ViewConfig {
  if (trashed.size === 0) return next;
  const kept: ViewConfig = { ...next };
  const lists = {
    fieldOrder: columnList,
    hiddenFields: columnList,
    cardFields: columnList,
  } as const;
  for (const key of new Set(keys === "all" ? Object.keys(shape) : keys)) {
    if (
      key === "fieldOrder" ||
      key === "hiddenFields" ||
      key === "cardFields"
    ) {
      const list = reinsert(
        stored[key] ?? [],
        kept[key] ?? [],
        (name) => trashed.has(name),
        (left, right) => left === right,
      );
      setChecked(kept, key, list, lists[key]);
    } else if (key === "sort" || key === "groupBy") {
      const list = reinsert<{ column: string }>(
        stored[key] ?? [],
        kept[key] ?? [],
        (item) => trashed.has(item.column),
        (left, right) => left.column === right.column,
      );
      setChecked(kept, key, list, shape[key]);
    } else if (key === "columnWidths" || key === "aggregations") {
      const entries = Object.entries(stored[key] ?? {}).filter(
        ([name]) => trashed.has(name) && !(name in (kept[key] ?? {})),
      );
      if (entries.length > 0) {
        setChecked(
          kept,
          key,
          { ...Object.fromEntries(entries), ...kept[key] },
          shape[key],
        );
      }
    } else if (key === "filter") {
      const filter = keptFilter(stored.filter, kept.filter, trashed);
      if (filter) setChecked(kept, "filter", filter, filterGroupSchema);
    } else if (key === "form" && kept.form) {
      const fields = reinsert(
        stored.form?.fields ?? [],
        kept.form.fields ?? [],
        (field) => trashed.has(field.column),
        (left, right) => left.column === right.column,
      );
      setChecked(kept, "form", { ...kept.form, fields }, formConfigSchema);
    }
  }
  return kept;
}

/** Sets a key to a value only if the value is still a valid setting. */
function setChecked(
  config: ViewConfig,
  key: keyof ViewConfig,
  value: unknown,
  schema: z.ZodType,
): void {
  if (Array.isArray(value) && value.length === 0) return;
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    (config as Record<string, unknown>)[key] = parsed.data;
  }
}

/**
 * `next`, with the items of `stored` that `keep` picks and `next` lacks,
 * each after the nearest item it followed that `next` still has.
 */
function reinsert<T>(
  stored: readonly T[],
  next: readonly T[],
  keep: (item: T) => boolean,
  same: (left: T, right: T) => boolean,
): T[] {
  const result = [...next];
  stored.forEach((item, index) => {
    if (!keep(item) || result.some((other) => same(other, item))) return;
    let at = 0;
    for (let before = index - 1; before >= 0; before -= 1) {
      const previous = stored[before];
      const found =
        previous === undefined
          ? -1
          : result.findIndex((other) => same(other, previous));
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    result.splice(at, 0, item);
  });
  return result;
}

/** `next`, still restricted by the trashed fields' top-level conditions. */
function keptFilter(
  stored: FilterGroup | undefined,
  next: FilterGroup | undefined,
  trashed: ReadonlySet<string>,
): FilterGroup | undefined {
  if (stored?.conjunction !== "and") return undefined;
  const present = new Set(
    next?.conjunction === "and"
      ? next.conditions.map((node) => JSON.stringify(node))
      : [],
  );
  const conditions = stored.conditions.filter(
    (node) =>
      !("conjunction" in node) &&
      trashed.has(node.column) &&
      !present.has(JSON.stringify(node)),
  );
  if (conditions.length === 0) return undefined;
  if (!next) return { conjunction: "and", conditions };
  if (next.conjunction === "and") {
    return { ...next, conditions: [...next.conditions, ...conditions] };
  }
  return { conjunction: "and", conditions: [next, ...conditions] };
}
