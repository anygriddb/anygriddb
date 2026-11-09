import type { Database } from "@anygriddb/db";

/** Tables a person's home lists as opened last. */
export const RECENT_TABLES_SHOWN = 12;
/** Opened tables kept per person; older ones are forgotten. */
const RECENT_TABLES_KEPT = 50;

export type PinTarget = { baseId: string } | { tableId: string };

/**
 * A person's pins and recently opened tables, as ids. The caller shows
 * only those its catalog lists for that person: a table they can no
 * longer read, or one in the trash, stays hidden.
 */
export async function listShortcuts(db: Database, userId: string) {
  const pins = await db
    .selectFrom("pins")
    .select(["baseId", "tableId"])
    .where("userId", "=", userId)
    .orderBy("createdAt")
    .execute();
  const recents = await db
    .selectFrom("recentTables")
    .select(["tableId", "openedAt"])
    .where("userId", "=", userId)
    .orderBy("openedAt", "desc")
    .limit(RECENT_TABLES_SHOWN)
    .execute();
  return {
    pinnedBases: pins.flatMap((pin) => (pin.baseId ? [pin.baseId] : [])),
    pinnedTables: pins.flatMap((pin) => (pin.tableId ? [pin.tableId] : [])),
    recentTables: recents.map((recent) => ({
      tableId: recent.tableId,
      openedAt: new Date(recent.openedAt).toISOString(),
    })),
  };
}

export async function setPin(
  db: Database,
  userId: string,
  target: PinTarget,
  pinned: boolean,
): Promise<void> {
  if (pinned) {
    await db
      .insertInto("pins")
      .values({ userId, ...target })
      // Pinned already: nothing to do.
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    return;
  }
  let query = db.deleteFrom("pins").where("userId", "=", userId);
  query =
    "baseId" in target
      ? query.where("baseId", "=", target.baseId)
      : query.where("tableId", "=", target.tableId);
  await query.execute();
}

/** Records that a person opened a table, keeping their last fifty. */
export async function touchTable(
  db: Database,
  userId: string,
  tableId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("recentTables")
      .values({ userId, tableId })
      .onConflict((conflict) =>
        conflict
          .columns(["userId", "tableId"])
          .doUpdateSet({ openedAt: new Date() }),
      )
      .execute();
    await trx
      .deleteFrom("recentTables")
      .where("userId", "=", userId)
      .where(
        "tableId",
        "not in",
        trx
          .selectFrom("recentTables")
          .select("tableId")
          .where("userId", "=", userId)
          .orderBy("openedAt", "desc")
          .limit(RECENT_TABLES_KEPT),
      )
      .execute();
  });
}
