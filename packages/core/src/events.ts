import { z } from "zod";
import { WEBHOOK_EVENTS } from "./schemas";

/** Automations may write rows that trigger automations, this deep at most. */
export const MAX_EVENT_DEPTH = 3;

/**
 * A change to rows of one table, queued for webhooks and automations.
 * `columns` lists the fields an update touched, when known.
 */
export const rowEventSchema = z.object({
  tableId: z.uuid(),
  event: z.enum(WEBHOOK_EVENTS),
  /** A uuid, or a client table's key as text. */
  rowId: z.string().min(1).max(1_000).optional(),
  columns: z.array(z.string().max(63)).max(500).optional(),
  source: z.string().max(100).optional(),
  actorId: z.uuid().optional(),
  depth: z.int().min(0).max(MAX_EVENT_DEPTH).optional(),
  count: z.int().min(0).optional(),
  at: z.string().max(40).optional(),
  /** The audit entry the event comes from, when it comes from one. */
  auditId: z.uuid().optional(),
});

export type RowEvent = z.infer<typeof rowEventSchema>;

/** Delays before the 2nd, 3rd, and 4th attempts; then the delivery fails. */
const RETRY_DELAYS_SECONDS = [60, 300, 1_800] as const;

export function nextRetryDelay(attempts: number): number | null {
  return RETRY_DELAYS_SECONDS[attempts - 1] ?? null;
}

/** Consecutive failed deliveries before a webhook switches itself off. */
export const WEBHOOK_FAILURE_LIMIT = 10;

/**
 * Whether a webhook or automation watching `watched` cares about an update
 * of `changed`. An empty watch list, or an unknown change, always matches.
 */
export function touchesWatched(
  watched: readonly string[] | null | undefined,
  changed: readonly string[] | undefined,
): boolean {
  if (!watched || watched.length === 0 || !changed) return true;
  return changed.some((name) => watched.includes(name));
}
