/**
 * What an earlier change can put back (ADR 0089). The trail already
 * holds the before and after. This only says which fields of that
 * before a person may write again, and how a stored value becomes the
 * cell the writers accept.
 */
import { z } from "zod";
import { type CellValue } from "./cell-values";
import { numberToDecimal } from "./decimal";
import { AppError } from "./errors";
import type { FieldType } from "./field-types";
import { columnNameSchema } from "./names";
import { rowIdSchema } from "./schemas";

export const REVERT_KINDS = [
  "base",
  "table",
  "column",
  "view",
  "folder",
  "dashboard",
  "widget",
  "automation",
  "webhook",
] as const;

export type RevertKind = (typeof REVERT_KINDS)[number];

/** The catalog table the trail files each object under. */
export const REVERT_CATALOG_TABLE: Record<RevertKind, string> = {
  base: "bases",
  table: "data_tables",
  column: "data_columns",
  view: "views",
  folder: "table_folders",
  dashboard: "dashboards",
  widget: "dashboard_widgets",
  automation: "automations",
  webhook: "webhooks",
};

/** Fields a person may put back, in the names the API uses. */
export const REVERT_FIELDS: Record<RevertKind, readonly string[]> = {
  base: ["name", "description"],
  table: ["name", "description"],
  column: [
    "label",
    "description",
    "config",
    "requireReason",
    "required",
    "isUnique",
  ],
  view: ["name", "config"],
  folder: ["name"],
  dashboard: ["name", "description"],
  widget: ["title", "kind", "config"],
  automation: ["name", "enabled", "trigger", "actions"],
  webhook: [
    "name",
    "active",
    "events",
    "filter",
    "watchColumns",
    "includeValues",
    "target",
  ],
};

/** Trail JSON keeps the database's own names. */
const AUDIT_KEY: Record<string, string> = {
  requireReason: "require_reason",
  isUnique: "is_unique",
  watchColumns: "watch_columns",
  includeValues: "include_values",
  fieldType: "field_type",
  viewType: "view_type",
};

export type AuditPayload = Record<string, unknown> | null;

export function asPayload(value: unknown): AuditPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function payloadId(value: unknown): string | null {
  const id = asPayload(value)?.id;
  return typeof id === "string" ? id : null;
}

export function auditKey(field: string): string {
  return AUDIT_KEY[field] ?? field;
}

export function auditValue(payload: AuditPayload, field: string): unknown {
  if (!payload) return undefined;
  return payload[auditKey(field)];
}

const PREVIEW = 280;

/** Enough of a value to recognise it. The write uses the trail, not this. */
export function previewValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : canonical(value);
  return text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sameDocument(left: unknown, right: unknown): boolean {
  return canonical(left ?? null) === canonical(right ?? null);
}

export type EarlierChange = {
  field: string;
  before: string;
  after: string;
  canRevert: boolean;
};

/**
 * The fields an update changed, and which of them can be put back now.
 * `blocked` names fields the current object no longer accepts alone: a
 * widget's configuration after its kind changed. When `closed` is set,
 * nothing of the event comes back: the field's type, the view's type, or
 * the webhook's kind is no longer the one in the event.
 */
export function earlierChanges(input: {
  kind: RevertKind;
  oldValue: unknown;
  newValue: unknown;
  blocked?: ReadonlySet<string>;
  closed?: boolean;
}): { changes: EarlierChange[]; canRevertAll: boolean } {
  const oldPayload = asPayload(input.oldValue);
  const nextPayload = asPayload(input.newValue);
  const changes: EarlierChange[] = [];
  for (const field of REVERT_FIELDS[input.kind]) {
    const before = auditValue(oldPayload, field);
    const after = auditValue(nextPayload, field);
    if (sameDocument(before, after)) continue;
    const coupled = input.kind === "widget" && field === "kind";
    changes.push({
      field,
      before: previewValue(before),
      after: previewValue(after),
      canRevert:
        !input.closed &&
        !coupled &&
        !input.blocked?.has(field) &&
        oldPayload !== null,
    });
  }
  const canRevertAll =
    !input.closed &&
    oldPayload !== null &&
    changes.some((change) => change.canRevert || change.field === "kind");
  return { changes, canRevertAll };
}

/**
 * A cell as the trail's JSON kept it, in the shape a write accepts.
 * A JSON document is stored as JSON and travels as text. A number travels
 * as its decimal text.
 */
export function cellFromAudit(fieldType: FieldType, value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (fieldType === "json") {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }
  if (fieldType === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      const decimal = numberToDecimal(value);
      if (decimal !== undefined) return decimal;
    }
    if (typeof value === "string") return value;
  }
  if (fieldType === "rating" || fieldType === "duration") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (fieldType === "boolean") {
    if (typeof value === "boolean") return value;
  }
  if (
    fieldType === "multi_select" ||
    fieldType === "user" ||
    fieldType === "attachment"
  ) {
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      return value;
    }
    return null;
  }
  if (typeof value === "string") return value;
  throw new AppError("revert_unavailable");
}

const seenSchema = z
  .record(z.string().max(80), z.unknown())
  .refine((value) => Object.keys(value).length <= 300, {
    message: "Invalid body",
  });

export const earlierInputSchema = z
  .object({
    kind: z.enum(REVERT_KINDS),
    id: z.uuid(),
  })
  .strict();

export const revertCatalogInputSchema = z
  .object({
    kind: z.enum(REVERT_KINDS),
    id: z.uuid(),
    eventId: z.uuid(),
    field: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]*$/)
      .max(40)
      .optional(),
    seen: seenSchema,
  })
  .strict();

export const revertRowInputSchema = z
  .object({
    tableId: z.uuid(),
    recordId: rowIdSchema,
    eventId: z.uuid(),
    field: columnNameSchema.optional(),
    seen: seenSchema,
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
