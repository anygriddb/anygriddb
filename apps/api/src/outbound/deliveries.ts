import { AppError, nextRetryDelay, ceilingOf } from "@anygriddb/core";
import type { Database, DeliveryRow, NewRow } from "@anygriddb/db";
import { addJob, TASKS, type SqlExecutor } from "../queue/jobs.js";

/**
 * The instance's one journal of what it delivers outside (ADR 0125): a
 * table's webhooks and the notification channels. An emitter adds a
 * delivery and its first attempt together; the attempt, its retries on one
 * schedule, the sweep of attempts lost with a worker, a new try asked by a
 * person, and the purge are this module's. Each origin says how it sends a
 * delivery, and hears how it went.
 */

export type DeliveryOrigin = DeliveryRow["origin"];

/** What one attempt came to. */
export type AttemptOutcome =
  | { sent: true; status: number | null }
  | { sent: false; status: number | null; error: string }
  /** Nothing was tried: the destination is gone or switched off. */
  | { refused: string };

/** How an origin sends its deliveries, and what it does with the outcome. */
export type Destination = {
  attempt: (delivery: DeliveryRow) => Promise<AttemptOutcome>;
  delivered?: (delivery: DeliveryRow) => Promise<void>;
  /** A failed attempt that will be tried again. */
  retrying?: (delivery: DeliveryRow, error: string) => Promise<void>;
  /** The last attempt failed: the delivery gave up. */
  gaveUp?: (delivery: DeliveryRow, error: string) => Promise<void>;
};

export type Destinations = Record<DeliveryOrigin, Destination>;

const RETENTION_DAYS = ceilingOf("retention.deliveries_days");
/** A pending delivery whose attempt is this late lost its job: queue it again. */
const STALE_ATTEMPT_MS = 15 * 60_000;

/**
 * Queues the attempt that follows `attempts` earlier ones. The key names
 * that attempt, so adding it twice queues it once, and the attempt that
 * schedules the next one never collides with its own job.
 */
function queueAttempt(
  executor: SqlExecutor,
  delivery: { id: string; attempts: number },
  options: { runAt?: Date; replace?: boolean } = {},
): Promise<void> {
  return addJob(
    executor,
    TASKS.deliveryAttempt,
    { deliveryId: delivery.id },
    {
      runAt: options.runAt,
      // A destination's failures follow the delivery's own schedule; these
      // retries only cover the database being unreachable.
      maxAttempts: 3,
      jobKey: `delivery:${delivery.id}:${String(delivery.attempts)}`,
      jobKeyMode: options.replace ? "replace" : "unsafe_dedupe",
    },
  );
}

/**
 * Adds deliveries and their first attempts, in the caller's transaction so
 * that they exist together or not at all. An event a channel was already
 * given is not given again. Returns the ids added.
 */
export async function addDeliveries(
  executor: SqlExecutor,
  rows: ReadonlyArray<NewRow<"deliveries">>,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const now = new Date();
  const added = await executor
    .insertInto("deliveries")
    .values(rows.map((row) => ({ nextAttemptAt: now, ...row })))
    .onConflict((conflict) =>
      conflict
        .columns(["integrationId", "eventId"])
        .where("integrationId", "is not", null)
        .doNothing(),
    )
    .returning("id")
    .execute();
  for (const { id } of added) {
    await queueAttempt(executor, { id, attempts: 0 });
  }
  return added.map(({ id }) => id);
}

/** Writes down a delivery made and finished in a request: a test, a heartbeat. */
export async function noteDelivery(
  db: Database,
  row: NewRow<"deliveries"> & { status: "success" | "failed" },
): Promise<void> {
  await db
    .insertInto("deliveries")
    .values({ attempts: 1, finishedAt: new Date(), ...row })
    .execute();
}

/** One queued attempt: sends the delivery unless it is no longer pending. */
export async function runDelivery(
  db: Database,
  destinations: Destinations,
  deliveryId: string,
): Promise<void> {
  const delivery = await db
    .selectFrom("deliveries")
    .selectAll()
    .where("id", "=", deliveryId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!delivery) return;
  const destination = destinations[delivery.origin];
  const outcome = await destination.attempt(delivery);
  await recordOutcome(db, destination, delivery, outcome);
}

async function recordOutcome(
  db: Database,
  destination: Destination,
  delivery: DeliveryRow,
  outcome: AttemptOutcome,
): Promise<void> {
  const now = new Date();
  const pending = db
    .updateTable("deliveries")
    .where("id", "=", delivery.id)
    .where("status", "=", "pending");
  if ("refused" in outcome) {
    await pending
      .set({
        status: "failed",
        error: outcome.refused,
        nextAttemptAt: null,
        finishedAt: now,
      })
      .execute();
    return;
  }
  const attempts = delivery.attempts + 1;
  if (outcome.sent) {
    // What was sent is not kept once delivered.
    await pending
      .set({
        status: "success",
        attempts,
        responseStatus: outcome.status,
        error: null,
        payload: null,
        nextAttemptAt: null,
        finishedAt: now,
      })
      .execute();
    await destination.delivered?.(delivery);
    return;
  }
  const delay = nextRetryDelay(attempts);
  if (delay !== null) {
    const next = new Date(now.getTime() + delay * 1000);
    await db.transaction().execute(async (tx) => {
      await tx
        .updateTable("deliveries")
        .set({
          attempts,
          responseStatus: outcome.status,
          error: outcome.error,
          nextAttemptAt: next,
        })
        .where("id", "=", delivery.id)
        .where("status", "=", "pending")
        .execute();
      await queueAttempt(tx, { id: delivery.id, attempts }, { runAt: next });
    });
    await destination.retrying?.(delivery, outcome.error);
    return;
  }
  await pending
    .set({
      status: "failed",
      attempts,
      responseStatus: outcome.status,
      error: outcome.error,
      nextAttemptAt: null,
      finishedAt: now,
    })
    .execute();
  await destination.gaveUp?.(delivery, outcome.error);
}

/**
 * Queues a delivery that gave up again, from its first attempt, if what it
 * sends is still kept. `scope` narrows it to one webhook's deliveries.
 */
export async function retryDelivery(
  db: Database,
  deliveryId: string,
  scope: { webhookId?: string } = {},
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    let query = tx
      .updateTable("deliveries")
      .set({
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
        finishedAt: null,
      })
      .where("id", "=", deliveryId)
      .where("status", "=", "failed")
      .where("payload", "is not", null);
    if (scope.webhookId !== undefined) {
      query = query.where("webhookId", "=", scope.webhookId);
    }
    const updated = await query.returning("id").execute();
    if (updated.length === 0) {
      throw new AppError("invalid_delivery");
    }
    await queueAttempt(tx, { id: deliveryId, attempts: 0 }, { replace: true });
  });
}

/**
 * Queues again the pending deliveries whose attempt is long overdue: a job
 * lost with a crashed worker.
 */
export async function sweepDeliveries(db: Database): Promise<number> {
  const stale = await db
    .selectFrom("deliveries")
    .select(["id", "attempts"])
    .where("status", "=", "pending")
    .where("nextAttemptAt", "<", new Date(Date.now() - STALE_ATTEMPT_MS))
    .limit(500)
    .execute();
  for (const delivery of stale) {
    await queueAttempt(db, delivery, { replace: true });
  }
  return stale.length;
}

/** Deliveries are kept 30 days, then removed with what they sent. */
export async function purgeDeliveries(db: Database): Promise<void> {
  await db
    .deleteFrom("deliveries")
    .where(
      "createdAt",
      "<",
      new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000),
    )
    .execute();
}
