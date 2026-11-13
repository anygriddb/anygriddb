/**
 * Exports kept on the change trail (ROADMAP #31): who took what out of
 * the instance, by its kind, its format, and how many rows it held.
 * Never a value: what an export holds stays behind the table's rights.
 */
import type { Database } from "@anygriddb/db";

/** What was exported: a view's rows, a base's file, or a report. */
export const EXPORT_KINDS = [
  "view",
  "base",
  "access_report",
  "change_trail",
  "sign_in_trail",
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** An export as the trail keeps it, in the event's `new_value`. */
export type ExportRecord = {
  kind: ExportKind;
  /** `csv`, `json`, `xlsx`, `zip`. */
  format: string;
  /** Rows written, when the export counts rows. */
  rows?: number;
  viewId?: string;
  baseId?: string;
};

/** The export an event keeps, or null for any other event. */
export function exportRecordOf(value: unknown): ExportRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ExportRecord>;
  return typeof record.format === "string" &&
    EXPORT_KINDS.includes(record.kind as ExportKind)
    ? (record as ExportRecord)
    : null;
}

/**
 * Writes one export on the trail, once it is made. A view's export names
 * its table; a base's file names its base; a report names neither.
 */
export async function recordExport(
  db: Database,
  input: {
    userId: string;
    tableId?: string;
    /** Where it was asked from: `web`, or `api` with a token. */
    source: string;
    export: ExportRecord;
  },
): Promise<void> {
  await db
    .insertInto("auditEvents")
    .values({
      userId: input.userId,
      action: "export",
      tableId: input.tableId ?? null,
      recordId: null,
      oldValue: null,
      newValue: input.export,
      reason: null,
      source: input.source,
    })
    .execute();
}
