/**
 * Files no cell holds are released, and storage counts what is held
 * (ADR 0136). A job per table reads the keys its cells name, its trash
 * included, and compares them with the table's files: what no cell names
 * is released, what one names again is held again, and what was released
 * longer ago than the trash keeps what is deleted goes, for the sweep to
 * remove its stored object.
 */
import { AppError, limitIn } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { columnAttachmentKeys } from "../data/tables.js";
import { addJob, TASKS } from "../queue/jobs.js";
import { readGateSettings } from "../settings.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A file is sent before the change that names it: one younger than this
 * is not looked at, as the sweep does not.
 */
const SENT_FIRST_MS = DAY_MS;

/** Whether a table holds files, to ask whether one was let go. */
async function holdsFiles(db: Database, tableId: string): Promise<boolean> {
  const found = await db
    .selectFrom("dataColumns")
    .select("id")
    .where("tableId", "=", tableId)
    .where("fieldType", "=", "attachment")
    .executeTakeFirst();
  return found !== undefined;
}

/**
 * After a change of a table's rows: a job that looks whether a file was let
 * go, a little later, once however many changes come before it.
 */
export async function queueFileRelease(
  db: Database,
  tableId: string,
): Promise<void> {
  if (!(await holdsFiles(db, tableId))) return;
  await addJob(
    db,
    TASKS.fileRelease,
    { tableId },
    {
      jobKey: `file_release:${tableId}`,
      jobKeyMode: "preserve_run_at",
      runAt: new Date(Date.now() + 30_000),
      maxAttempts: 3,
    },
  );
}

export type ReleaseOutcome = {
  released: number;
  heldAgain: number;
  deleted: number;
};

/** Looks at one table's files: released, held again, deleted. */
export async function releaseFilesOf(
  db: Database,
  tableId: string,
  now: Date = new Date(),
): Promise<ReleaseOutcome> {
  const table = await db
    .selectFrom("dataTables")
    .select(["physicalName", "storage"])
    .where("id", "=", tableId)
    .executeTakeFirst();
  if (!table || table.storage !== "native") {
    return { released: 0, heldAgain: 0, deleted: 0 };
  }
  // Every field of files, those in the trash too: its values may come back.
  const columns = await db
    .selectFrom("dataColumns")
    .select("name")
    .where("tableId", "=", tableId)
    .where("fieldType", "=", "attachment")
    .execute();
  const held = await columnAttachmentKeys(
    db,
    table.physicalName,
    columns.map((column) => column.name),
  );
  const days = (await readGateSettings(db)).trashDays;
  const sentBefore = new Date(now.getTime() - SENT_FIRST_MS);
  const keptSince = new Date(now.getTime() - days * DAY_MS);
  // A file sent to a form waits for its answer: it is the form's to claim.
  const released = await db
    .updateTable("attachments")
    .set({ releasedAt: now })
    .where("tableId", "=", tableId)
    .where("releasedAt", "is", null)
    .where("stagedShareId", "is", null)
    .where("createdAt", "<", sentBefore)
    .where(sql<boolean>`not (key = any(${held}::text[]))`)
    .executeTakeFirst();
  const heldAgain =
    held.length === 0
      ? { numUpdatedRows: 0n }
      : await db
          .updateTable("attachments")
          .set({ releasedAt: null })
          .where("tableId", "=", tableId)
          .where("releasedAt", "is not", null)
          .where(sql<boolean>`key = any(${held}::text[])`)
          .executeTakeFirst();
  const deleted = await db
    .deleteFrom("attachments")
    .where("tableId", "=", tableId)
    .where("releasedAt", "<", keptSince)
    .where(sql<boolean>`not (key = any(${held}::text[]))`)
    .executeTakeFirst();
  return {
    released: Number(released.numUpdatedRows),
    heldAgain: Number(heldAgain.numUpdatedRows),
    deleted: Number(deleted.numDeletedRows),
  };
}

/** Every table that has files, each looked at: the nightly pass. */
export async function releaseAllFiles(db: Database): Promise<ReleaseOutcome> {
  const tables = await db
    .selectFrom("attachments")
    .select("tableId")
    .distinct()
    .execute();
  const total = { released: 0, heldAgain: 0, deleted: 0 };
  for (const { tableId } of tables) {
    const outcome = await releaseFilesOf(db, tableId);
    total.released += outcome.released;
    total.heldAgain += outcome.heldAgain;
    total.deleted += outcome.deleted;
  }
  return total;
}

/** The size of the files a base holds. */
export async function baseStorage(
  db: Database,
  baseId: string,
): Promise<number> {
  const row = await db
    .selectFrom("attachments as a")
    .innerJoin("dataTables as t", "t.id", "a.tableId")
    .select((eb) =>
      eb.fn.coalesce(eb.fn.sum<string>("a.size"), sql`0`).as("size"),
    )
    .where("t.baseId", "=", baseId)
    .where("a.releasedAt", "is", null)
    .executeTakeFirst();
  return Number(row?.size ?? 0);
}

/** The size of the files an account sent that are held. */
export async function accountStorage(
  db: Database,
  userId: string,
): Promise<number> {
  const row = await db
    .selectFrom("attachments")
    .select((eb) =>
      eb.fn.coalesce(eb.fn.sum<string>("size"), sql`0`).as("size"),
    )
    .where("createdBy", "=", userId)
    .where("releasedAt", "is", null)
    .executeTakeFirst();
  return Number(row?.size ?? 0);
}

/**
 * Refuses a file that would take its base or its sender past their quota
 * (`storage_full`, which names which); a quota of 0 is none.
 */
export async function assertStorageRoom(
  db: Database,
  input: { tableId: string; userId: string; size: number },
): Promise<void> {
  const settings = await readGateSettings(db);
  const perBase = limitIn("storage.base_bytes", settings.limits);
  const perAccount = limitIn("storage.account_bytes", settings.limits);
  if (perBase > 0) {
    const table = await db
      .selectFrom("dataTables")
      .select("baseId")
      .where("id", "=", input.tableId)
      .executeTakeFirst();
    if (table && (await baseStorage(db, table.baseId)) + input.size > perBase) {
      throw new AppError("storage_full", "base");
    }
  }
  if (
    perAccount > 0 &&
    (await accountStorage(db, input.userId)) + input.size > perAccount
  ) {
    throw new AppError("storage_full", "account");
  }
}

/**
 * What a base and an account hold at most, and how many hold their quota or
 * more, for Limits and usage; a quota of 0 has none past it.
 */
export async function storageUse(
  db: Database,
  quotas: { base: number; account: number },
): Promise<{
  base: { most: number; past: number };
  account: { most: number; past: number };
}> {
  const [bases, accounts] = await Promise.all([
    db
      .selectFrom("attachments as a")
      .innerJoin("dataTables as t", "t.id", "a.tableId")
      .select((eb) => eb.fn.sum<string>("a.size").as("size"))
      .where("a.releasedAt", "is", null)
      .groupBy("t.baseId")
      .execute(),
    db
      .selectFrom("attachments")
      .select((eb) => eb.fn.sum<string>("size").as("size"))
      .where("releasedAt", "is", null)
      .where("createdBy", "is not", null)
      .groupBy("createdBy")
      .execute(),
  ]);
  const use = (sizes: ReadonlyArray<{ size: string }>, quota: number) => {
    const held = sizes.map((row) => Number(row.size));
    return {
      most: held.reduce((most, size) => Math.max(most, size), 0),
      past: quota > 0 ? held.filter((size) => size >= quota).length : 0,
    };
  };
  return {
    base: use(bases, quotas.base),
    account: use(accounts, quotas.account),
  };
}
