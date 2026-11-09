import type { Database } from "@anygriddb/db";
import type { FileStore } from "./store.js";

/** Writes store a file before the row that names it: a day covers them all. */
export const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;

const ATTACHMENT = /^att/;
const EXPORT = /^exports\//;
const STAGED = /^staged\//;

/** The keys of `keys` that a row still names. */
async function referenced(
  db: Database,
  keys: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const attachments = keys.filter((key) => ATTACHMENT.test(key));
  if (attachments.length > 0) {
    const rows = await db
      .selectFrom("attachments")
      .select(["key", "thumbKey"])
      .where((eb) =>
        eb.or([
          eb("key", "in", attachments),
          eb("thumbKey", "in", attachments),
        ]),
      )
      .execute();
    for (const row of rows) {
      found.add(row.key);
      if (row.thumbKey) found.add(row.thumbKey);
    }
  }
  const exports = keys.filter((key) => EXPORT.test(key));
  if (exports.length > 0) {
    const rows = await db
      .selectFrom("jobs")
      .select("fileKey")
      .where("fileKey", "in", exports)
      .execute();
    for (const row of rows) if (row.fileKey) found.add(row.fileKey);
  }
  const staged = keys.filter((key) => STAGED.test(key));
  if (staged.length > 0) {
    const rows = await db
      .selectFrom("stagedUploads")
      .select("fileKey")
      .where("fileKey", "in", staged)
      .execute();
    for (const row of rows) found.add(row.fileKey);
  }
  return found;
}

/** A key the sweep knows how to check. Any other kind is always kept. */
function checkable(key: string): boolean {
  return ATTACHMENT.test(key) || EXPORT.test(key) || STAGED.test(key);
}

export type SweepReport = { checked: number; removed: number; tidied: number };

/**
 * Deletes files that no row names: an attachment or a thumbnail whose
 * upload never reached its row, an export or a staged upload whose row is
 * gone. Only files older than `before` are considered, so a write in
 * progress is never swept. A store belongs to one instance: another
 * instance's files in the same folder or bucket would look orphaned.
 */
export async function sweepOrphanFiles(
  deps: { db: Database; files: FileStore },
  options: {
    before?: Date;
    dryRun?: boolean;
    onOrphan?: (key: string) => void;
    onError: (key: string, error: unknown) => void;
  },
): Promise<SweepReport> {
  const before = options.before ?? new Date(Date.now() - SWEEP_GRACE_MS);
  const report: SweepReport = { checked: 0, removed: 0, tidied: 0 };

  const sweep = async (batch: string[]) => {
    const kept = await referenced(deps.db, batch);
    for (const key of batch) {
      if (kept.has(key)) continue;
      options.onOrphan?.(key);
      if (options.dryRun) {
        report.removed += 1;
        continue;
      }
      try {
        await deps.files.delete(key);
        report.removed += 1;
      } catch (error) {
        options.onError(key, error);
      }
    }
  };

  let batch: string[] = [];
  for await (const entry of deps.files.list()) {
    if (entry.modifiedAt >= before || !checkable(entry.key)) continue;
    report.checked += 1;
    batch.push(entry.key);
    if (batch.length >= BATCH) {
      await sweep(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await sweep(batch);
  if (!options.dryRun) report.tidied = await deps.files.tidy(before);
  return report;
}
