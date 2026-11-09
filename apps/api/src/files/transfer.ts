import type { FileStore } from "./store.js";

export type CopyReport = {
  /** Files copied, or that a dry run would copy. */
  copied: number;
  /** Files already in the target with the same size. */
  skipped: number;
  failed: number;
  bytes: number;
};

/**
 * Copies every file of `source` that `target` lacks, streamed, a few at a
 * time. It never deletes: the source stays whole until the operator
 * removes it. A key always names the same bytes, so a file already in the
 * target with the same size is skipped, and a second run copies only what
 * was written since the first.
 */
export async function copyFiles(
  source: FileStore,
  target: FileStore,
  options: {
    dryRun?: boolean;
    concurrency?: number;
    onError: (key: string, error: unknown) => void;
    onProgress?: (report: CopyReport) => void;
  },
): Promise<CopyReport> {
  const present = new Map<string, number>();
  for await (const entry of target.list()) present.set(entry.key, entry.size);
  const report: CopyReport = { copied: 0, skipped: 0, failed: 0, bytes: 0 };
  const entries = source.list()[Symbol.asyncIterator]();

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = await entries.next();
      if (next.done) return;
      const entry = next.value;
      if (present.get(entry.key) === entry.size) {
        report.skipped += 1;
      } else if (options.dryRun) {
        report.copied += 1;
        report.bytes += entry.size;
      } else {
        try {
          const file = await source.open(entry.key);
          if (file) {
            try {
              await target.putFile(entry.key, file);
            } finally {
              file.body.destroy();
            }
            report.copied += 1;
            report.bytes += file.size;
          } else {
            // Deleted since the listing: nothing to keep.
            report.skipped += 1;
          }
        } catch (error) {
          report.failed += 1;
          options.onError(entry.key, error);
        }
      }
      options.onProgress?.(report);
    }
  };

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 32));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return report;
}
