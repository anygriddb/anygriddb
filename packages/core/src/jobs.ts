import { z } from "zod";
import { columnNameSchema, labelSchema } from "./names";
import {
  EXPORT_FORMATS,
  importIdSchema,
  importMappingSchema,
  reasonSchema,
} from "./schemas";
import {
  duplicateBaseJobInputSchema,
  exportSnapshotJobInputSchema,
  importSnapshotJobInputSchema,
} from "./snapshot";
import {
  restoreBaseJobInputSchema,
  restorePointJobInputSchema,
} from "./restore-points";
import { trashPurgeJobInputSchema } from "./trash";

/**
 * Background jobs: long imports, exports, and copies run in a worker
 * instead of the request, and report their progress to their author.
 */
export const JOB_KINDS = [
  "import",
  "export",
  "duplicate_table",
  "trash_purge",
  "export_snapshot",
  "import_snapshot",
  "import_airtable",
  "duplicate_base",
  "restore_point",
  "restore_base",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** A running job holds its lease this long without a heartbeat. */
export const JOB_LEASE_MS = 2 * 60_000;
export const JOB_HEARTBEAT_MS = 30_000;
/** Progress is written and published at most this often. */
export const JOB_PROGRESS_INTERVAL_MS = 1_000;
/** Queued or running jobs one person may have at once. */
export const MAX_ACTIVE_JOBS = 5;
/** Finished jobs stay listed this long. */
export const JOB_RETENTION_DAYS = 7;
/** An export file can be downloaded this long. */
export const EXPORT_FILE_HOURS = 24;

export function isActiveJob(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

/** Share of the work done, from 0 to 1, or null while the total is unknown. */
export function jobFraction(done: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(1, Math.max(0, done / total));
}

/**
 * Whether a progress report is worth writing: the first one, the last
 * one, or one at least `JOB_PROGRESS_INTERVAL_MS` after the previous.
 */
export function progressDue(
  last: number | undefined,
  now: number,
  done: number,
  total: number | null,
): boolean {
  if (last === undefined) return true;
  if (total !== null && done >= total) return true;
  return now - last >= JOB_PROGRESS_INTERVAL_MS;
}

export const exportJobInputSchema = z
  .object({
    tableId: z.uuid(),
    viewId: z.uuid().optional(),
    format: z.enum(EXPORT_FORMATS).default("csv"),
    search: z.string().trim().min(1).max(200).optional(),
    timeZone: z.string().max(64).optional(),
  })
  .strict();

export type ExportJobInput = z.infer<typeof exportJobInputSchema>;

export const duplicateJobInputSchema = z
  .object({
    tableId: z.uuid(),
    name: labelSchema,
    withData: z.boolean(),
  })
  .strict();
/**
 * An import as the worker runs it: the target table already exists, and
 * `created` names the columns made with it, in mapping order.
 */
export const importJobInputSchema = z
  .object({
    importId: importIdSchema,
    tableId: z.uuid(),
    mapping: z.array(importMappingSchema).min(1).max(200),
    upsertSource: z.int().min(0).max(199).optional(),
    addOptions: z.boolean(),
    reason: reasonSchema.optional(),
    created: z.array(columnNameSchema).max(200).optional(),
  })
  .strict();
/** An Airtable base's id, as its address or the API writes it. */
const AIRTABLE_BASE = /\bapp[A-Za-z0-9]{14}\b/;

/** The base id in an Airtable address (`airtable.com/appX/...`) or alone. */
export function airtableBaseId(text: string): string | undefined {
  return AIRTABLE_BASE.exec(text)?.[0];
}

/** What a person gives to import an Airtable base. */
export const startAirtableImportInputSchema = z
  .object({
    /** The base's address, or its id (`app…`). */
    base: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((text) => airtableBaseId(text) !== undefined),
    /** A personal access token with `data.records:read` and `schema.bases:read`. */
    token: z
      .string()
      .trim()
      .regex(/^pat[A-Za-z0-9._-]{20,200}$/),
    name: labelSchema.optional(),
  })
  .strict();
/**
 * An Airtable import as the worker runs it. The token is sealed with the
 * instance's key, and the job drops it when it ends.
 */
export const importAirtableJobInputSchema = z
  .object({
    airtableBaseId: z.string().regex(/^app[A-Za-z0-9]{14}$/),
    name: labelSchema.optional(),
    token: z
      .object({
        ciphertext: z.string().min(1).max(2_000),
        nonce: z.string().min(1).max(64),
      })
      .strict()
      .optional(),
  })
  .strict();
export const jobInputSchemas = {
  import: importJobInputSchema,
  export: exportJobInputSchema,
  duplicate_table: duplicateJobInputSchema,
  trash_purge: trashPurgeJobInputSchema,
  export_snapshot: exportSnapshotJobInputSchema,
  import_snapshot: importSnapshotJobInputSchema,
  import_airtable: importAirtableJobInputSchema,
  duplicate_base: duplicateBaseJobInputSchema,
  restore_point: restorePointJobInputSchema,
  restore_base: restoreBaseJobInputSchema,
} as const satisfies Record<JobKind, z.ZodType>;

export const jobIdInputSchema = z.object({ jobId: z.uuid() }).strict();

export const listJobsInputSchema = z
  .object({ limit: z.int().min(1).max(50).default(20) })
  .strict();
