/**
 * The change trail kept for a time (ADR 0069): once a day, events older
 * than the administrators chose are deleted, a batch at a time, and the
 * purge itself is written on the trail under the name of who chose.
 * Nothing else deletes from the trail.
 */
import type { InstanceSettings } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { ERASED_USER_ID } from "./erasure.js";

const DAY_MS = 86_400_000;
/** Events one statement deletes: far inside the pool's time for one. */
const BATCH = 5_000;
/** How long one run goes on: a trail of years empties over several days. */
const RUN_MS = 5 * 60_000;

/** What a purge writes on the trail, in its event's `new_value`. */
export type PurgeRecord = {
  /** Events deleted by this run. */
  events: number;
  /** Everything from before this moment went. */
  before: string;
  days: number;
};

/** The purge an event keeps, or null for any other event. */
export function purgeRecordOf(value: unknown): PurgeRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<PurgeRecord>;
  return typeof record.events === "number" && typeof record.before === "string"
    ? (record as PurgeRecord)
    : null;
}

/**
 * Deletes the events older than `days`, and says so on the trail when
 * some went. `days` at 0 keeps the trail for ever: nothing is deleted.
 * Answers how many events went.
 */
export async function purgeAuditEvents(
  db: Database,
  days: InstanceSettings["auditRetentionDays"],
  now: Date = new Date(),
): Promise<number> {
  if (days === 0) return 0;
  const before = new Date(now.getTime() - days * DAY_MS);
  const until = Date.now() + RUN_MS;
  let events = 0;
  for (;;) {
    const deleted = await db.transaction().execute(async (tx) => {
      // The one flag that lets a row of the trail go, for this
      // transaction only.
      await sql`select set_config('anygrid.purge_audit', 'on', true)`.execute(
        tx,
      );
      const gone = await sql`
        delete from audit_events
         where id in (
           select id from audit_events
            where occurred_at < ${before}
            order by occurred_at
            limit ${BATCH}
         )
      `.execute(tx);
      return Number(gone.numAffectedRows ?? 0);
    });
    events += deleted;
    if (deleted < BATCH || Date.now() > until) break;
  }
  if (events === 0) return 0;
  // Under the name of who chose how long the trail is kept; the erased
  // account stands for someone who has since left.
  const chosen = await db
    .selectFrom("instanceSettings")
    .select("updatedBy")
    .where("key", "=", "auditRetentionDays")
    .executeTakeFirst();
  const record: PurgeRecord = { events, before: before.toISOString(), days };
  await db
    .insertInto("auditEvents")
    .values({
      userId: chosen?.updatedBy ?? ERASED_USER_ID,
      action: "purge",
      tableId: null,
      recordId: null,
      oldValue: null,
      newValue: record,
      reason: null,
      source: "retention",
      occurredAt: now,
    })
    .execute();
  return events;
}
