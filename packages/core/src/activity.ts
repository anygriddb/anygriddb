import { z } from "zod";

/**
 * A base's activity, read by its members: who changed what,
 * and when, in the tables, fields, and rows each member may see. Field
 * names only: values stay in each row's history, behind its rights.
 */

/** Where a page ends: its last event's instant, to the microsecond, and id. */
const cursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[0-9a-f-]{36}$/);

export const baseActivityInputSchema = z
  .object({
    baseId: z.uuid(),
    /** The events before this one, newest first. */
    before: cursorSchema.optional(),
    limit: z.int().min(1).max(100).default(50),
  })
  .strict();

export const ACTIVITY_KINDS = [
  "row_added",
  "row_changed",
  "row_moved",
  "row_deleted",
  "row_submitted",
  "row_locked",
  "row_unlocked",
  "row_signed",
  "field_added",
  "field_changed",
  "field_deleted",
  "table_added",
  "table_renamed",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** One thing someone did in a base, as a member may read it. */
export type ActivityEvent = {
  id: string;
  at: string;
  by: { id: string; name: string };
  kind: ActivityKind;
  tableId: string;
  table: string;
  /** The row an edit is about, and its primary field as the reader sees it now. */
  rowId: string | null;
  row: string | null;
  /** The fields an edit changed, by label: only those the reader may see. */
  fields: string[];
  /** The field a structure change is about, by label. */
  field: string | null;
  /** What a renamed field or table was called before. */
  before: string | null;
};
