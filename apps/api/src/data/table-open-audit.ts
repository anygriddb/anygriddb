/**
 * Opens of a table on the change trail (ROADMAP #31): who opened which
 * table, when a manager has turned that on for the table. Off by default
 * so every page of every table does not write an event. At most one event
 * per person and table in an hour.
 */
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { liveTable } from "./live.js";

/** One open per person and table inside this window. */
export const TABLE_OPEN_DEDUP_HOURS = 1;

/**
 * Writes one open on the trail when the table records them, and none has
 * been written for this person and table in the last hour. Returns whether
 * an event was written.
 */
export async function recordTableOpen(
  db: Database,
  input: { userId: string; tableId: string; source: string },
): Promise<boolean> {
  const table = await db
    .selectFrom("dataTables")
    .select(["id", "trailReads"])
    .where("id", "=", input.tableId)
    .where(liveTable())
    .executeTakeFirst();
  if (!table?.trailReads) return false;

  const recent = await db
    .selectFrom("auditEvents")
    .select("id")
    .where("userId", "=", input.userId)
    .where("tableId", "=", input.tableId)
    .where("action", "=", "open")
    .where(
      "occurredAt",
      ">",
      sql<Date>`now() - make_interval(hours => ${TABLE_OPEN_DEDUP_HOURS})`,
    )
    .limit(1)
    .executeTakeFirst();
  if (recent) return false;

  await db
    .insertInto("auditEvents")
    .values({
      userId: input.userId,
      action: "open",
      tableId: input.tableId,
      recordId: null,
      oldValue: null,
      newValue: { kind: "table" },
      reason: null,
      source: input.source,
    })
    .execute();
  return true;
}
