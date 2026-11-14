import { z } from "zod";
import { formulaExprSchema, type FormulaExpr } from "./formula";
import { type FieldType } from "./field-types";
import { AppError } from "./errors";
import { filterGroupSchema, type FilterGroup } from "./filter";

/**
 * The rows a link field offers and accepts: those of a shared view of the
 * linked table, or those a filter keeps.
 */
export type LinkSelection = { view: string } | { filter: FilterGroup };

// Lazy: `filter` reads cell values, which read this module.
const linkSelectionSchema: z.ZodType<LinkSelection> = z.lazy(() =>
  z.union([
    z.object({ view: z.uuid() }).strict(),
    z.object({ filter: filterGroupSchema }).strict(),
  ]),
);

export const OPTION_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "brown",
] as const;

export type OptionColor = (typeof OPTION_COLORS)[number];

export const optionColorSchema = z.enum(OPTION_COLORS);

const COLUMN_REF = /^[a-z_][a-z0-9_]*$/;
const columnRefSchema = z.string().regex(COLUMN_REF).max(63);

export function isTimeZone(value: string): boolean {
  if (value === "UTC") {
    return true;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value);
  } catch {
    return false;
  }
}

const timeZoneSchema = z
  .string()
  .max(64)
  .refine(isTimeZone, { message: "Invalid time zone" });

const selectOptionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    color: optionColorSchema,
  })
  .strict();

export type SelectOption = z.infer<typeof selectOptionSchema>;

const selectOptionsSchema = z
  .array(selectOptionSchema)
  .min(1)
  .max(200)
  .superRefine((options, context) => {
    const names = options.map((option) => option.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "Duplicate option" });
    }
  });

const numberFormatSchema = z
  .object({
    precision: z.int().min(0).max(8).optional(),
    style: z.enum(["decimal", "percent", "currency"]).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    thousands: z.boolean().optional(),
  })
  .strict();

type NumberFormat = z.infer<typeof numberFormatSchema>;

const dateFormatSchema = z
  .object({
    format: z.enum(["iso", "eu", "us", "long", "relative"]).optional(),
    hour12: z.boolean().optional(),
    timeZone: timeZoneSchema.optional(),
  })
  .strict();

export type DateFormat = z.infer<typeof dateFormatSchema>;

const DURATION_FORMATS = ["h:mm", "h:mm:ss", "d h:mm"] as const;

export const RATING_ICONS = ["star", "heart", "thumb", "flag", "fire"] as const;

/** How a single-select is shown and edited (default: coloured chips + list). */
export const SINGLE_SELECT_APPEARANCES = ["badge", "text", "radio"] as const;
export type SingleSelectAppearance = (typeof SINGLE_SELECT_APPEARANCES)[number];

/** How a multi-select is shown and edited (default: coloured chips + list). */
export const MULTI_SELECT_APPEARANCES = ["badge", "text", "checklist"] as const;
export type MultiSelectAppearance = (typeof MULTI_SELECT_APPEARANCES)[number];

/** How a boolean is shown (default: check glyph). */
export const BOOLEAN_APPEARANCES = ["check", "switch", "yes_no"] as const;
export type BooleanAppearance = (typeof BOOLEAN_APPEARANCES)[number];

export const ROLLUP_FNS = [
  "count",
  "counta",
  "count_unique",
  "sum",
  "avg",
  // Each distinct value once, and the spread of the values: of a sample,
  // or of the whole population (`_pop`).
  "sum_distinct",
  "avg_distinct",
  "std_dev",
  "variance",
  "std_dev_pop",
  "variance_pop",
  "min",
  "max",
  "and",
  "or",
  "concatenate",
  "array_unique",
  "earliest",
  "latest",
] as const;

export type RollupFn = (typeof ROLLUP_FNS)[number];

/** Rollups that compute on numbers: a checkbox counts 1 when checked. */
const NUMERIC_ROLLUPS = new Set<RollupFn>([
  "sum",
  "avg",
  "sum_distinct",
  "avg_distinct",
  "std_dev",
  "variance",
  "std_dev_pop",
  "variance_pop",
]);
const NUMERIC_TARGETS = new Set<FieldType>([
  "number",
  "rating",
  "duration",
  "autonumber",
  "boolean",
]);
const DATE_TARGETS = new Set<FieldType>([
  "date",
  "datetime",
  "created_time",
  "last_modified_time",
]);
/** Fields whose values depend on what they compute: any function may fit. */
const COMPUTED_TARGETS = new Set<FieldType>(["formula", "lookup", "rollup"]);

/** Whether a rollup function computes on a field of this type. */
export function rollupFitsTarget(fn: RollupFn, target: FieldType): boolean {
  if (COMPUTED_TARGETS.has(target)) return true;
  if (NUMERIC_ROLLUPS.has(fn)) return NUMERIC_TARGETS.has(target);
  if (fn === "earliest" || fn === "latest") return DATE_TARGETS.has(target);
  return true;
}

export const rollupFnSchema = z.enum(ROLLUP_FNS);

/** Parsed, validated column configuration. Each type uses a subset. */
export type ColumnConfig = {
  options?: SelectOption[];
  preventNewOptions?: boolean;
  /** Select / boolean presentation (read and edit); omitted = current default. */
  appearance?:
    SingleSelectAppearance | MultiSelectAppearance | BooleanAppearance;
  number?: NumberFormat;
  /** A number field that takes no value under zero, on every write. */
  nonNegative?: boolean;
  date?: DateFormat;
  durationFormat?: (typeof DURATION_FORMATS)[number];
  ratingMax?: number;
  ratingIcon?: (typeof RATING_ICONS)[number];
  ratingColor?: OptionColor;
  multiple?: boolean;
  notify?: boolean;
  richText?: boolean;
  expr?: FormulaExpr;
  relation?: string;
  target?: string;
  fn?: RollupFn;
  defaultValue?: string | number | boolean;
  inverseOf?: string;
  selectFrom?: LinkSelection;
  /** A lookup's or rollup's condition on the linked rows it reads. */
  filter?: FilterGroup;
  button?: ButtonConfig;
};

const textDefault = z.string().max(4_000).optional();

/**
 * A button opens a URL built from a template, or runs the automations
 * whose trigger is this button.
 */
const buttonConfigSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    color: optionColorSchema.optional(),
    action: z.enum(["open_url", "run_automation"]),
    url: z.string().trim().min(1).max(2_000).optional(),
    automationId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (config) =>
      config.action === "open_url"
        ? Boolean(config.url) && !config.automationId
        : !config.url,
    { message: "Invalid column" },
  );

export type ButtonConfig = z.infer<typeof buttonConfigSchema>;

const CONFIG_SCHEMAS: Record<FieldType, z.ZodType<ColumnConfig>> = {
  text: z.object({ defaultValue: textDefault }).strict(),
  long_text: z
    .object({ richText: z.boolean().optional(), defaultValue: textDefault })
    .strict(),
  email: z.object({}).strict(),
  url: z.object({}).strict(),
  phone: z.object({}).strict(),
  number: z
    .object({
      number: numberFormatSchema.optional(),
      defaultValue: z.number().optional(),
      nonNegative: z.boolean().optional(),
    })
    .strict()
    // A default the field itself would refuse is no default.
    .refine(
      (config) =>
        !config.nonNegative ||
        config.defaultValue === undefined ||
        config.defaultValue >= 0,
      { message: "Negative default", path: ["defaultValue"] },
    ),
  rating: z
    .object({
      ratingMax: z.int().min(1).max(10).optional(),
      ratingIcon: z.enum(RATING_ICONS).optional(),
      ratingColor: optionColorSchema.optional(),
    })
    .strict(),
  duration: z
    .object({ durationFormat: z.enum(DURATION_FORMATS).optional() })
    .strict(),
  boolean: z
    .object({
      defaultValue: z.boolean().optional(),
      appearance: z.enum(BOOLEAN_APPEARANCES).optional(),
    })
    .strict(),
  date: z.object({ date: dateFormatSchema.optional() }).strict(),
  datetime: z.object({ date: dateFormatSchema.optional() }).strict(),
  single_select: z
    .object({
      options: selectOptionsSchema,
      preventNewOptions: z.boolean().optional(),
      defaultValue: z.string().max(80).optional(),
      appearance: z.enum(SINGLE_SELECT_APPEARANCES).optional(),
    })
    .strict(),
  multi_select: z
    .object({
      options: selectOptionsSchema,
      preventNewOptions: z.boolean().optional(),
      appearance: z.enum(MULTI_SELECT_APPEARANCES).optional(),
    })
    .strict(),
  user: z
    .object({
      multiple: z.boolean().optional(),
      notify: z.boolean().optional(),
    })
    .strict(),
  attachment: z.object({}).strict(),
  relation_one_to_many: z
    .object({
      inverseOf: z.uuid().optional(),
      selectFrom: linkSelectionSchema.optional(),
    })
    .strict(),
  relation_many_to_many: z
    .object({
      inverseOf: z.uuid().optional(),
      selectFrom: linkSelectionSchema.optional(),
    })
    .strict(),
  formula: z
    .object({
      expr: formulaExprSchema,
      number: numberFormatSchema.optional(),
      date: dateFormatSchema.optional(),
    })
    .strict(),
  lookup: z
    .object({
      relation: columnRefSchema,
      target: columnRefSchema,
      filter: z.lazy(() => filterGroupSchema).optional(),
    })
    .strict(),
  rollup: z
    .object({
      relation: columnRefSchema,
      target: columnRefSchema,
      fn: rollupFnSchema,
      number: numberFormatSchema.optional(),
      filter: z.lazy(() => filterGroupSchema).optional(),
    })
    .strict(),
  created_time: z.object({ date: dateFormatSchema.optional() }).strict(),
  last_modified_time: z.object({ date: dateFormatSchema.optional() }).strict(),
  created_by: z.object({}).strict(),
  last_modified_by: z.object({}).strict(),
  autonumber: z.object({}).strict(),
  row_id: z.object({}).strict(),
  button: z.object({ button: buttonConfigSchema }).strict(),
};

function legacyOptions(raw: unknown): unknown {
  if (!Array.isArray(raw)) {
    return raw;
  }
  return (raw as unknown[]).map((item, index) =>
    typeof item === "string"
      ? { name: item, color: OPTION_COLORS[index % OPTION_COLORS.length] }
      : item,
  );
}

/**
 * Validates a column configuration for its type. Stored configurations
 * written before option colours (`options: string[]`) are upgraded here.
 */
export function parseColumnConfig(
  fieldType: FieldType,
  raw: unknown,
): ColumnConfig {
  const source: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  if ("options" in source) {
    source.options = legacyOptions(source.options);
  }
  if (source.fn === undefined) {
    delete source.fn;
  }
  const parsed = CONFIG_SCHEMAS[fieldType].safeParse(source);
  if (!parsed.success) {
    throw new AppError("invalid_column");
  }
  return parsed.data;
}

export function selectOptionNames(config: ColumnConfig): string[] {
  return (config.options ?? []).map((option) => option.name);
}
