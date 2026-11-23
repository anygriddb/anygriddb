/**
 * The change trail kept for a time (ADR 0069): once a day, events older
 * than the administrators chose are deleted, a batch at a time, and the
 * purge itself is written on the trail under the name of who chose.
 * Nothing else deletes from the trail.
 */
import type { InstanceSettings } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";

/** Events one statement deletes: far inside the pool's time for one. */
const BATCH = 5_000;
/** How long one run goes on: a trail of years empties over several days. */
const RUN_MS = 5 * 60_000;

/** What a purge writes on the trail, in its event's `new_value`. */
type PurgeRecord = {
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
  const until = Date.now() + RUN_MS;
  let events = 0;
  for (;;) {
    // The trail's owner deletes, within the instance's retention, and
    // writes what went on the trail itself (ADR 0119).
    const { rows } = await sql<{ gone: number }>`
      select ag_purge_audit_events(${days}::int, ${now}::timestamptz, ${BATCH}::int) as gone
    `.execute(db);
    const deleted = rows[0]?.gone ?? 0;
    events += deleted;
    if (deleted < BATCH || Date.now() > until) break;
  }
  return events;
}
