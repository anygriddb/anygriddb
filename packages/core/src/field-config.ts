import { z } from "zod";
import {
  formulaExprSchema,
  formulaReferences,
  type FormulaExpr,
} from "./formula";
import { compareDecimals, isDecimalString, numberToDecimal } from "./decimal";
import { type FieldType } from "./field-types";
import { AppError } from "./errors";
import { fitsMask, isMask } from "./text-mask";
import {
  filterColumnNames,
  filterGroupSchema,
  filterKeeping,
  type FilterGroup,
} from "./filter";

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

/**
 * How a short text is shown (default: its text): drawn as a QR code or as
 * a barcode, which a scanner reads back as the same text. The value is
 * the field's own, so a formula draws the code of another field.
 */
export const TEXT_APPEARANCES = ["text", "qr", "barcode"] as const;
export type TextAppearance = (typeof TEXT_APPEARANCES)[number];
const textAppearanceSchema = z.enum(TEXT_APPEARANCES).optional();

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
  /** How the value is shown (and a select edited); omitted = the default. */
  appearance?:
    | SingleSelectAppearance
    | MultiSelectAppearance
    | BooleanAppearance
    | TextAppearance;
  number?: NumberFormat;
  /**
   * A number field's smallest and largest value, bounds included, as exact
   * decimals (ADR 0141), held on every write.
   */
  min?: string;
  max?: string;
  /** A short text field's longest value, in characters (ADR 0141). */
  maxLength?: number;
  /** A short text field's mask, which every value fits (`text-mask.ts`). */
  mask?: string;
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

/** A bound of a number field: an exact decimal (ADR 0023). */
const boundSchema = z.string().refine(isDecimalString).optional();

/** Whether a number lies within a field's bounds, both included. */
export function withinBounds(
  value: string,
  bounds: Pick<ColumnConfig, "min" | "max">,
): boolean {
  return (
    (bounds.min === undefined || compareDecimals(value, bounds.min) >= 0) &&
    (bounds.max === undefined || compareDecimals(value, bounds.max) <= 0)
  );
}

/**
 * A field's settings as a file written before ADR 0141 may hold them: a
 * number that refused negative numbers takes a smallest value of 0, as
 * migration 0160 does for the fields of an instance.
 */
export function settingsFromBefore(
  fieldType: string,
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!Object.hasOwn(config, "nonNegative")) return { ...config };
  const { nonNegative, ...rest } = config;
  return fieldType === "number" &&
    nonNegative === true &&
    rest.min === undefined
    ? { ...rest, min: "0" }
    : rest;
}

/**
 * A number field's bounds as a refusal says them, in no language: `0 – 120`,
 * `≥ 0`, `≤ 120`.
 */
export function boundsText(bounds: Pick<ColumnConfig, "min" | "max">): string {
  if (bounds.min !== undefined && bounds.max !== undefined) {
    return `${bounds.min} – ${bounds.max}`;
  }
  return bounds.min !== undefined ? `≥ ${bounds.min}` : `≤ ${bounds.max ?? ""}`;
}

/** Whether a text keeps to a short text field's length and mask. */
export function fitsTextRules(
  value: string,
  rules: Pick<ColumnConfig, "maxLength" | "mask">,
): "ok" | "too_long" | "mismatch" {
  if (
    rules.maxLength !== undefined &&
    Array.from(value).length > rules.maxLength
  ) {
    return "too_long";
  }
  if (rules.mask !== undefined && !fitsMask(rules.mask, value)) {
    return "mismatch";
  }
  return "ok";
}

const CONFIG_SCHEMAS: Record<FieldType, z.ZodType<ColumnConfig>> = {
  text: z
    .object({
      defaultValue: textDefault,
      appearance: textAppearanceSchema,
      // The most a short text holds (`CELL_TEXT_LIMITS.text`).
      maxLength: z.int().min(1).max(4_000).optional(),
      mask: z.string().refine(isMask).optional(),
    })
    .strict()
    // A default the field itself would refuse is no default.
    .refine(
      (config) =>
        config.defaultValue === undefined ||
        config.defaultValue === "" ||
        fitsTextRules(config.defaultValue, config) === "ok",
      { message: "Default out of the field's rules", path: ["defaultValue"] },
    ),
  long_text: z
    .object({ richText: z.boolean().optional(), defaultValue: textDefault })
    .strict(),
  email: z.object({}).strict(),
  url: z.object({ appearance: textAppearanceSchema }).strict(),
  phone: z.object({}).strict(),
  color: z.object({}).strict(),
  place: z.object({}).strict(),
  json: z.object({}).strict(),
  number: z
    .object({
      number: numberFormatSchema.optional(),
      defaultValue: z.number().optional(),
      min: boundSchema,
      max: boundSchema,
    })
    .strict()
    .refine(
      (config) =>
        config.min === undefined ||
        config.max === undefined ||
        compareDecimals(config.min, config.max) <= 0,
      { message: "Smallest above largest", path: ["max"] },
    )
    // A default the field itself would refuse is no default.
    .refine(
      (config) => {
        if (config.defaultValue === undefined) return true;
        const value = numberToDecimal(config.defaultValue);
        return value !== undefined && withinBounds(value, config);
      },
      { message: "Default out of bounds", path: ["defaultValue"] },
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
      appearance: textAppearanceSchema,
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
  autonumber: z.object({ appearance: textAppearanceSchema }).strict(),
  row_id: z.object({ appearance: textAppearanceSchema }).strict(),
  row_state: z.object({}).strict(),
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

/**
 * What a field's settings say of how its values are drawn and typed: all
 * a public link gets. A setting added later stays private until named
 * here. What a field computes from, its default, and where it points are
 * the table's own.
 */
const LINK_CONFIG_KEYS = [
  "options",
  "preventNewOptions",
  "appearance",
  "number",
  "min",
  "max",
  "maxLength",
  "mask",
  "date",
  "durationFormat",
  "ratingMax",
  "ratingIcon",
  "ratingColor",
  "multiple",
  "richText",
] as const satisfies ReadonlyArray<keyof ColumnConfig>;

export function linkColumnConfig(config: ColumnConfig): ColumnConfig {
  return Object.fromEntries(
    LINK_CONFIG_KEYS.flatMap((key) =>
      config[key] === undefined ? [] : [[key, config[key]]],
    ),
  );
}

/**
 * A field's settings for a reader under field rules: a formula, a lookup,
 * or a condition that names a field hidden from them says what that field
 * is for, and the values it is compared to. `hidden` asks of this table,
 * `linkedHidden` of the table the field links to.
 */
export function readerColumnConfig(
  config: ColumnConfig,
  rules: {
    hidden: (name: string) => boolean;
    linkedHidden: (name: string) => boolean;
  },
): ColumnConfig {
  const next: ColumnConfig = { ...config };
  if (next.expr && formulaReferences(next.expr).some(rules.hidden)) {
    delete next.expr;
  }
  if (
    (next.relation !== undefined && rules.hidden(next.relation)) ||
    (next.target !== undefined && rules.linkedHidden(next.target))
  ) {
    delete next.relation;
    delete next.target;
    delete next.fn;
    delete next.filter;
  }
  if (next.filter && filterColumnNames(next.filter).some(rules.linkedHidden)) {
    delete next.filter;
  }
  if (next.selectFrom && "filter" in next.selectFrom) {
    next.selectFrom = {
      filter: filterKeeping(
        next.selectFrom.filter,
        (name) => !rules.linkedHidden(name),
      ),
    };
  }
  if (next.button?.url) {
    next.button = {
      ...next.button,
      url: next.button.url.replace(
        /\{\{\s*([A-Za-z0-9_]{1,63})\s*\}\}/g,
        (whole: string, name: string) => (rules.hidden(name) ? "" : whole),
      ),
    };
  }
  return next;
}
