/**
 * Files sent to a public form before its answer (ADR 0062). Each belongs
 * to the form's link, with a deadline, until the answer that carries it
 * is written: that write claims it in the row's own transaction, once. A
 * file never claimed is removed after its deadline.
 */
import { AppError } from "@anygriddb/core";
import type { Database, Executor } from "@anygriddb/db";
import { sql } from "kysely";
import { deleteFiles, type FileStore } from "../files/index.js";

/** How long a file waits for its answer: a form left open for the day. */
export const STAGED_ATTACHMENT_HOURS = 24;

/** The deadline of a file staged now, in the database's own clock. */
export function stagedDeadline() {
  return sql<Date>`now() + make_interval(hours => ${STAGED_ATTACHMENT_HOURS})`;
}

/**
 * Makes the files of an answer the table's own. Each must have been sent
 * through this link and not have been claimed or have expired: otherwise
 * nothing is written. Runs inside the transaction that writes the row, so
 * an answer refused leaves its files waiting.
 */
export async function claimStagedAttachments(
  tx: Executor,
  shareId: string,
  keys: readonly string[],
): Promise<void> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;
  const claimed = await tx
    .updateTable("attachments")
    .set({ stagedShareId: null, stagedUntil: null })
    .where("key", "in", unique)
    .where("stagedShareId", "=", shareId)
    .where("stagedUntil", ">", sql<Date>`now()`)
    .returning("key")
    .execute();
  if (claimed.length !== unique.length) {
    throw new AppError("invalid_attachment");
  }
}

/**
 * Removes the files whose deadline passed an hour ago, rows and bytes. The
 * hour keeps a purge away from an answer being written right at the
 * deadline: that transaction lasts seconds.
 */
export async function purgeStagedAttachments(
  db: Database,
  files: FileStore,
  onError: (error: unknown) => void,
): Promise<number> {
  const expired = await db
    .deleteFrom("attachments")
    .where("stagedUntil", "<", sql<Date>`now() - interval '1 hour'`)
    .returning(["key", "thumbKey"])
    .execute();
  await deleteFiles(
    files,
    expired.flatMap((row) =>
      row.thumbKey ? [row.key, row.thumbKey] : [row.key],
    ),
    onError,
  );
  return expired.length;
}
