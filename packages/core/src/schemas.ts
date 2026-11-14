import { z } from "zod";
import { cellValueSchema } from "./cell-values";
import { rollupFnSchema } from "./field-config";
import { formulaExprSchema } from "./formula";
import { FIELD_TYPES, type FieldType } from "./field-types";
import { filterGroupSchema, legacyFilterSchema } from "./filter";
import {
  columnLabelSchema,
  columnNameSchema,
  isReservedColumnName,
  labelSchema,
} from "./names";
import {
  aggregateItemSchema,
  groupSpecSchema,
  rowSortSchema,
} from "./query/read";
import { MAX_BATCH_ROWS } from "./query/write";
import {
  MAX_VIEW_GROUPS,
  MAX_VIEW_SORTS,
  viewConfigPatchSchema,
  viewConfigSchema,
  viewTypeSchema,
} from "./view-config";
import { AppError } from "./errors";

const fieldTypeSchema = z.enum(FIELD_TYPES);

export const descriptionSchema = z.string().trim().max(2_000);

export const reasonSchema = z.string().trim().min(1).max(500);

/**
 * The zone a browser says it is in: a hint, never refused. A read falls
 * back on UTC for a zone the server does not know (`safeTimeZone`), where
 * refusing it here would refuse every read of that browser: one that
 * cannot tell its zone reports "Etc/Unknown".
 */
const timeZoneInputSchema = z.string().max(64);

const userColumnName = columnNameSchema.refine(
  (name) => !isReservedColumnName(name),
  {
    message: "Duplicate column",
  },
);

/** Types a column can be created as directly. Links, lookups, rollups have their own procedures. */
export const CREATABLE_TYPES = FIELD_TYPES.filter(
  (
    type,
  ): type is Exclude<
    FieldType,
    "relation_one_to_many" | "relation_many_to_many" | "lookup" | "rollup"
  > =>
    type !== "relation_one_to_many" &&
    type !== "relation_many_to_many" &&
    type !== "lookup" &&
    type !== "rollup",
);

export const columnDefinitionSchema = z
  .object({
    name: userColumnName.optional(),
    /** Defaults to `name` for clients written before labels. */
    label: columnLabelSchema.optional(),
    fieldType: z.enum(CREATABLE_TYPES),
    description: descriptionSchema.optional(),
    requireReason: z.boolean().optional(),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    formulaSource: z.string().trim().min(1).max(4_000).optional(),
    /** Pre-v2 shapes, folded into `config`. */
    formula: formulaExprSchema.optional(),
    options: z
      .array(z.string().trim().min(1).max(80))
      .min(1)
      .max(200)
      .optional(),
  })
  .strict()
  .superRefine((column, context) => {
    if (!column.name && !column.label) {
      context.addIssue({ code: "custom", message: "Invalid column" });
    }
  });

export type ColumnDefinition = z.infer<typeof columnDefinitionSchema>;

export const createBaseInputSchema = z.object({
  name: labelSchema,
  description: descriptionSchema.optional(),
  template: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
});

export const updateBaseInputSchema = z.object({
  baseId: z.uuid(),
  name: labelSchema.optional(),
  description: descriptionSchema.nullable().optional(),
});

export const deleteBaseInputSchema = z.object({ baseId: z.uuid() });

export const createTableInputSchema = z.object({
  baseId: z.uuid(),
  name: labelSchema,
  description: descriptionSchema.optional(),
  columns: z.array(columnDefinitionSchema).min(1).max(200),
});

export const updateTableInputSchema = z.object({
  tableId: z.uuid(),
  name: labelSchema.optional(),
  description: descriptionSchema.nullable().optional(),
});

export const deleteTableInputSchema = z.object({ tableId: z.uuid() });

export const reorderTablesInputSchema = z.object({
  baseId: z.uuid(),
  order: z.array(z.uuid()).min(1).max(500),
});

export const addColumnInputSchema = z.object({
  tableId: z.uuid(),
  /** Insert before the column at this position. Appends when absent. */
  position: z.int().min(0).max(1_000).optional(),
  column: columnDefinitionSchema.optional(),
  name: userColumnName.optional(),
  label: columnLabelSchema.optional(),
  fieldType: z.enum(CREATABLE_TYPES).optional(),
  description: descriptionSchema.optional(),
  requireReason: z.boolean().optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  formulaSource: z.string().trim().min(1).max(4_000).optional(),
  formula: formulaExprSchema.optional(),
  options: z.array(z.string().trim().min(1).max(80)).min(1).max(200).optional(),
});

/** The column an `addColumn` call describes, nested or flat. */
export function columnFromAddInput(
  input: z.infer<typeof addColumnInputSchema>,
): ColumnDefinition {
  if (input.column) {
    return input.column;
  }
  const parsed = columnDefinitionSchema.safeParse({
    name: input.name,
    label: input.label,
    fieldType: input.fieldType,
    description: input.description,
    requireReason: input.requireReason,
    required: input.required,
    unique: input.unique,
    config: input.config,
    formulaSource: input.formulaSource,
    formula: input.formula,
    options: input.options,
  });
  if (!parsed.success) {
    throw new AppError("invalid_column");
  }
  return parsed.data;
}

export const updateColumnInputSchema = z.object({
  tableId: z.uuid(),
  name: columnNameSchema,
  label: columnLabelSchema.optional(),
  description: descriptionSchema.nullable().optional(),
  requireReason: z.boolean().optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  fieldType: fieldTypeSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  formulaSource: z.string().trim().min(1).max(4_000).optional(),
  reason: reasonSchema.optional(),
});

export const deleteColumnInputSchema = z.object({
  tableId: z.uuid(),
  name: columnNameSchema,
});

export const reorderColumnsInputSchema = z.object({
  tableId: z.uuid(),
  order: z.array(columnNameSchema).min(1).max(500),
});

export const setPrimaryColumnInputSchema = z.object({
  tableId: z.uuid(),
  name: columnNameSchema,
});

export const previewConversionInputSchema = z.object({
  tableId: z.uuid(),
  name: columnNameSchema,
  fieldType: fieldTypeSchema,
});

export const rowsReadInputSchema = z.object({
  tableId: z.uuid(),
  viewId: z.uuid().optional(),
  filter: filterGroupSchema.optional(),
  /** Flat filters from older clients, ANDed with `filter`. */
  filters: z.array(legacyFilterSchema).max(50).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  sort: z.array(rowSortSchema).max(MAX_VIEW_SORTS).optional(),
  groupBy: z
    .union([columnNameSchema, z.array(groupSpecSchema).max(MAX_VIEW_GROUPS)])
    .optional(),
  fields: z.array(columnNameSchema).max(500).optional(),
  offset: z.int().min(0).max(10_000_000).default(0),
  limit: z.int().min(1).max(1000).default(100),
  timeZone: timeZoneInputSchema.optional(),
  /** Ignore the view's own filter and sort, e.g. to show every row of a kanban stack. */
  ignoreViewFilter: z.boolean().optional(),
  /** Count the rows: the first page does, the next ones need not. */
  withTotal: z.boolean().default(true),
  /**
   * What a grouped read says of its groups: each one's row count, also
   * where its rows start (a grid lays out its headers from them; it numbers
   * every row of the view, so only a first page asks), or nothing.
   */
  withGroups: z.enum(["none", "counts", "starts"]).default("counts"),
  /**
   * Count exactly, even a large client table whose total the engine's
   * statistics would estimate (ADR 0005).
   */
  exactTotal: z.boolean().optional(),
});
/**
 * A row's id: AnyGridDB's uuid, or a client table's key as text (ADR
 * 0006). A text that names no row of a table finds none.
 */
export const rowIdSchema = z
  .string()
  .min(1)
  .max(1_000)
  .regex(/^\P{Cc}+$/u);

export const rowsGetInputSchema = z.object({
  tableId: z.uuid(),
  rowIds: z.array(rowIdSchema).min(1).max(500),
  timeZone: timeZoneInputSchema.optional(),
});

export const rowsAggregateInputSchema = z.object({
  tableId: z.uuid(),
  viewId: z.uuid().optional(),
  filter: filterGroupSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  items: z.array(aggregateItemSchema).min(1).max(60),
  timeZone: timeZoneInputSchema.optional(),
});

const rowValuesSchema = z.record(columnNameSchema, cellValueSchema);

/**
 * Just before a row of AnyGridDB's own, or just after it, in the table's
 * order (`row-order.ts`).
 */
const rowPlaceSchema = z.union([
  z.strictObject({ before: z.uuid() }),
  z.strictObject({ after: z.uuid() }),
]);

export const insertRowInputSchema = z.object({
  tableId: z.uuid(),
  values: rowValuesSchema,
  reason: reasonSchema.optional(),
  place: rowPlaceSchema.optional(),
});

export const insertRowsInputSchema = z.object({
  tableId: z.uuid(),
  rows: z.array(rowValuesSchema).min(1).max(MAX_BATCH_ROWS),
  reason: reasonSchema.optional(),
  place: rowPlaceSchema.optional(),
});

/** Rows put beside another, keeping the order they had among themselves. */
export const moveRowsInputSchema = z.object({
  tableId: z.uuid(),
  rowIds: z.array(z.uuid()).min(1).max(MAX_BATCH_ROWS),
  place: rowPlaceSchema,
});

/**
 * A row's id: AnyGridDB's uuid, or a client table's key as text. `expected`
 * holds what the writer saw in the fields it changes: a client's table
 * refuses the write when they moved since (ADR 0006).
 */
const rowUpdateSchema = z.object({
  rowId: rowIdSchema,
  values: rowValuesSchema,
  expected: rowValuesSchema.optional(),
});
export const updateRowsInputSchema = z.object({
  tableId: z.uuid(),
  updates: z.array(rowUpdateSchema).min(1).max(MAX_BATCH_ROWS),
  reason: reasonSchema.optional(),
});
export const deleteRowsInputSchema = z.object({
  tableId: z.uuid(),
  rowIds: z.array(rowIdSchema).min(1).max(MAX_BATCH_ROWS),
  reason: reasonSchema.optional(),
});

export const restoreRowsInputSchema = z.object({
  tableId: z.uuid(),
  rowIds: z.array(rowIdSchema).min(1).max(100),
  reason: reasonSchema.optional(),
});

export const trashInputSchema = z.object({
  tableId: z.uuid(),
  limit: z.int().min(1).max(200).default(50),
});
const relationKindSchema = z.enum(["one_to_many", "many_to_many"]);

export const addRelationInputSchema = z.object({
  tableId: z.uuid(),
  name: userColumnName.optional(),
  label: columnLabelSchema.optional(),
  kind: relationKindSchema,
  targetTableId: z.uuid(),
  /** Also create the inverse column on the target table. */
  twoWay: z.boolean().optional(),
  inverseLabel: columnLabelSchema.optional(),
});

export const setLinksInputSchema = z
  .object({
    tableId: z.uuid(),
    rowId: rowIdSchema,
    column: columnNameSchema,
    targetIds: z.array(rowIdSchema).max(500),
    reason: reasonSchema.optional(),
  })
  .superRefine((input, context) => {
    if (new Set(input.targetIds).size !== input.targetIds.length) {
      context.addIssue({ code: "custom", message: "Duplicate link" });
    }
  });

export const linkCandidatesInputSchema = z.object({
  tableId: z.uuid(),
  column: columnNameSchema,
  search: z.string().trim().max(200).optional(),
  limit: z.int().min(1).max(100).default(30),
});

export const setStatusInputSchema = z.object({
  tableId: z.uuid(),
  rowId: rowIdSchema,
  status: z.enum(["submitted", "locked", "draft"]),
});

export const signRowInputSchema = z.object({
  tableId: z.uuid(),
  rowId: rowIdSchema,
  meaning: z.string().trim().min(1).max(500),
  password: z.string().min(12).max(128),
});

export const auditReadInputSchema = z.object({
  tableId: z.uuid(),
  recordId: rowIdSchema,
});

/** The tables the home page lists: what each holds, and its last change. */
export const TABLE_ACTIVITY_MAX = 8;

export const tableActivityInputSchema = z.object({
  tableIds: z.array(z.uuid()).min(1).max(TABLE_ACTIVITY_MAX),
});

export type AuditRole = "owner" | "editor" | "commenter" | "viewer";

export function resolveChangeReason(
  columns: readonly { name: string; requireReason: boolean }[],
  touched: readonly string[] | "all",
  reason: string | undefined,
): string | null {
  const names =
    touched === "all" ? columns.map((column) => column.name) : touched;
  const needed = names.some((name) =>
    columns.some((column) => column.name === name && column.requireReason),
  );
  if (!needed) {
    return null;
  }
  if (!reason || reason.trim() === "") {
    throw new AppError("reason_required");
  }
  if (reason.trim().length > 500) {
    throw new AppError("invalid_reason");
  }
  return reason.trim();
}

/** A cell that holds nothing: no value, blank text, or an empty list. */
export function isBlankCell(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Refuses a write that leaves a required field empty, naming the field: a
 * new row fills each one, a change never empties one. A row written before
 * its field was required keeps what it holds until that field is changed.
 */
export function assertRequiredValues(
  columns: readonly { name: string; label: string; required: boolean }[],
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  mode: "insert" | "update",
): void {
  const required = columns.filter((column) => column.required);
  if (required.length === 0) return;
  for (const values of rows) {
    for (const column of required) {
      if (mode === "update" && !(column.name in values)) continue;
      if (isBlankCell(values[column.name])) {
        throw new AppError("value_required", column.label);
      }
    }
  }
}

export function assertStatusTransition(
  from: string,
  to: "submitted" | "locked" | "draft",
  role: AuditRole,
): void {
  if (
    to === "submitted" &&
    from === "draft" &&
    (role === "owner" || role === "editor")
  ) {
    return;
  }
  if (to === "locked" && from === "submitted" && role === "owner") {
    return;
  }
  if (
    to === "draft" &&
    (from === "locked" || from === "signed") &&
    role === "owner"
  ) {
    return;
  }
  throw new AppError("invalid_status");
}

export const listViewsInputSchema = z.object({ tableId: z.uuid() });

export const createViewInputSchema = z.object({
  tableId: z.uuid(),
  name: labelSchema,
  viewType: viewTypeSchema,
  config: viewConfigSchema.optional(),
  personal: z.boolean().optional(),
});

export const updateViewInputSchema = z.object({
  viewId: z.uuid(),
  name: labelSchema.optional(),
  /** Replaces the whole configuration. */
  config: viewConfigSchema.optional(),
  /** Merges into the configuration; `null` removes a key. */
  patch: viewConfigPatchSchema.optional(),
  locked: z.boolean().optional(),
});

export const deleteViewInputSchema = z.object({ viewId: z.uuid() });

export const duplicateViewInputSchema = z.object({
  viewId: z.uuid(),
  name: labelSchema.optional(),
});

export const reorderViewsInputSchema = z.object({
  tableId: z.uuid(),
  order: z.array(z.uuid()).min(1).max(200),
});

export const listCommentsInputSchema = z.object({
  tableId: z.uuid(),
  rowId: rowIdSchema,
});

export const addCommentInputSchema = z.object({
  tableId: z.uuid(),
  rowId: rowIdSchema,
  body: z.string().trim().min(1).max(4_000),
  parentId: z.uuid().optional(),
});

export const updateCommentInputSchema = z.object({
  commentId: z.uuid(),
  body: z.string().trim().min(1).max(4_000),
});

export const deleteCommentInputSchema = z.object({ commentId: z.uuid() });
export const addLookupInputSchema = z.object({
  tableId: z.uuid(),
  name: userColumnName.optional(),
  label: columnLabelSchema.optional(),
  relation: columnNameSchema,
  target: columnNameSchema,
  /** Only the linked rows that match, on the linked table's fields. */
  filter: filterGroupSchema.optional(),
});

export const addRollupInputSchema = addLookupInputSchema.extend({
  fn: rollupFnSchema,
});
export const createApiTokenInputSchema = z.object({
  name: labelSchema,
  /** Limit the token to these bases. Absent means every base of its owner. */
  baseIds: z.array(z.uuid()).max(50).optional(),
  readOnly: z.boolean().optional(),
  days: z.int().min(1).max(365).optional(),
});

export const revokeApiTokenInputSchema = z.object({ tokenId: z.uuid() });

export const WEBHOOK_EVENTS = [
  "insert",
  "update",
  "delete",
  "status",
  "import",
] as const;

const webhookEventSchema = z.enum(WEBHOOK_EVENTS);

/** Headers a webhook may not set: transport, framing, and our signature. */
const RESERVED_HEADERS =
  /^(host|content-length|content-type|connection|transfer-encoding|te|upgrade|expect|proxy-.*|x-anygrid-.*)$/i;

function isAllowedWebhookHeader(name: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(name) && !RESERVED_HEADERS.test(name);
}

const webhookHeadersSchema = z
  .record(
    z.string(),
    z
      .string()
      .max(1_000)
      .regex(/^[^\r\n]*$/),
  )
  .refine(
    (headers) =>
      Object.keys(headers).length <= 10 &&
      Object.keys(headers).every(isAllowedWebhookHeader),
    { message: "Invalid webhook" },
  );

const webhookOptions = {
  name: z.string().trim().max(100).optional(),
  filter: filterGroupSchema.optional(),
  watchColumns: z.array(columnNameSchema).max(50).optional(),
  headers: webhookHeadersSchema.optional(),
  includeValues: z.boolean().optional(),
};

export const createWebhookInputSchema = z
  .object({
    tableId: z.uuid(),
    kind: z.enum(["http", "smtp"]),
    target: z.string().trim().min(1).max(500),
    events: z.array(webhookEventSchema).min(1).max(WEBHOOK_EVENTS.length),
    ...webhookOptions,
  })
  .superRefine((input, context) => {
    if (new Set(input.events).size !== input.events.length) {
      context.addIssue({ code: "custom", message: "Invalid webhook" });
    }
    if (input.kind === "smtp" && !z.email().safeParse(input.target).success) {
      context.addIssue({ code: "custom", message: "Invalid webhook" });
    }
    if (input.kind === "smtp" && input.headers) {
      context.addIssue({ code: "custom", message: "Invalid webhook" });
    }
    if (input.kind === "http") {
      try {
        const url = new URL(input.target);
        if (url.protocol !== "https:" || url.username || url.password) {
          context.addIssue({ code: "custom", message: "Invalid webhook" });
        }
      } catch {
        context.addIssue({ code: "custom", message: "Invalid webhook" });
      }
    }
  });

export const updateWebhookInputSchema = z.object({
  webhookId: z.uuid(),
  active: z.boolean().optional(),
  events: z
    .array(webhookEventSchema)
    .min(1)
    .max(WEBHOOK_EVENTS.length)
    .refine((events) => new Set(events).size === events.length, {
      message: "Invalid webhook",
    })
    .optional(),
  name: webhookOptions.name,
  /** `null` removes the filter or the watched columns. */
  filter: filterGroupSchema.nullable().optional(),
  watchColumns: z.array(columnNameSchema).max(50).nullable().optional(),
  headers: webhookHeadersSchema.nullable().optional(),
  includeValues: z.boolean().optional(),
});

export const webhookIdInputSchema = z.object({ webhookId: z.uuid() });

export const webhookDeliveriesInputSchema = z.object({
  webhookId: z.uuid(),
  limit: z.int().min(1).max(200).default(50),
});

export const retryDeliveryInputSchema = z.object({ deliveryId: z.uuid() });

export const deleteWebhookInputSchema = z.object({ webhookId: z.uuid() });

export const listWebhooksInputSchema = z.object({ tableId: z.uuid() });

export const duplicateTableInputSchema = z.object({
  tableId: z.uuid(),
  name: labelSchema.optional(),
  withData: z.boolean().default(false),
});

export const duplicateColumnInputSchema = z.object({
  tableId: z.uuid(),
  name: columnNameSchema,
});

export const IMPORT_FORMATS = ["csv", "tsv", "json", "xlsx"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const EXPORT_FORMATS = ["csv", "json", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Staged imports are named by a random base64url id. */
export const importIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);

const importTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new"), baseId: z.uuid(), name: labelSchema }),
  z.object({ kind: z.literal("existing"), tableId: z.uuid() }),
]);

/**
 * One source column goes into an existing column (`column`) or a new one
 * (`create`). Unmapped source columns are ignored.
 */
export const importMappingSchema = z
  .object({
    source: z.int().min(0).max(199),
    column: columnNameSchema.optional(),
    create: z
      .object({
        label: columnLabelSchema,
        fieldType: z.enum(CREATABLE_TYPES),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (entry) => (entry.column === undefined) !== (entry.create === undefined),
    {
      message: "Invalid mapping",
    },
  );

export const importCommitInputSchema = z
  .object({
    importId: importIdSchema,
    target: importTargetSchema,
    mapping: z.array(importMappingSchema).min(1).max(200),
    /** Source column whose value finds the row to update instead of inserting. */
    upsertSource: z.int().min(0).max(199).optional(),
    /** Unknown select values become new options instead of errors. */
    addOptions: z.boolean().default(true),
    reason: reasonSchema.optional(),
  })
  .superRefine((input, context) => {
    const sources = input.mapping.map((entry) => entry.source);
    if (new Set(sources).size !== sources.length) {
      context.addIssue({ code: "custom", message: "Invalid mapping" });
    }
    const targets = input.mapping.flatMap((entry) =>
      entry.column ? [entry.column] : [],
    );
    if (new Set(targets).size !== targets.length) {
      context.addIssue({ code: "custom", message: "Invalid mapping" });
    }
    if (
      input.target.kind === "new" &&
      input.mapping.some((entry) => entry.column !== undefined)
    ) {
      context.addIssue({ code: "custom", message: "Invalid mapping" });
    }
    if (
      input.upsertSource !== undefined &&
      (input.target.kind === "new" || !sources.includes(input.upsertSource))
    ) {
      context.addIssue({ code: "custom", message: "Invalid mapping" });
    }
  });

export type ImportCommitInput = z.infer<typeof importCommitInputSchema>;
