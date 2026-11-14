import { z } from "zod";
import { labelSchema } from "./names";

/**
 * A base's restore points (ADR 0077): its snapshot, rows and files
 * included, kept in the instance's store for as long as the instance keeps
 * them (`restorePointDays`), listed on the base's page, and read back into
 * a new base in one step.
 */

/** Restore points one base keeps at once. */
export const MAX_RESTORE_POINTS = 20;

/** What the person who made it says about a restore point. */
export const restorePointNoteSchema = z.string().trim().min(1).max(200);

export const restorePointJobInputSchema = z
  .object({ baseId: z.uuid(), note: restorePointNoteSchema.optional() })
  .strict();

export const restoreBaseJobInputSchema = z
  .object({ restorePointId: z.uuid(), name: labelSchema.optional() })
  .strict();

export const listRestorePointsInputSchema = z
  .object({ baseId: z.uuid() })
  .strict();

export const restorePointIdInputSchema = z
  .object({ restorePointId: z.uuid() })
  .strict();

/** A restore point as its base's page lists it. */
export type RestorePoint = {
  id: string;
  baseId: string;
  createdAt: string;
  expiresAt: string;
  createdBy: { id: string; name: string } | null;
  size: number;
  rows: number;
  files: number;
  note: string | null;
};
