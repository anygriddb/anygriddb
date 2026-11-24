/**
 * The change trail's copy where the database cannot reach it (ADR 0120).
 * Each event leaves for the instance's collectors as a fingerprint: what it
 * is (its id, order, time, action and authors) and a keyed digest of all it
 * holds, never a value. Events go in the order they were written, in
 * numbered batches that each carry the digest of the batch before, so that
 * a batch lost or changed on the way shows at the collector, and an event
 * later rewritten in the database shows against it (`trail-verify.ts`).
 */
import { createHash, createHmac } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { currentKey, type KeyRing } from "../auth/key-ring.js";
import type { SyslogCollector } from "../env.js";
import { readSettings } from "../settings.js";
import { loadSiemRow, postToSiem } from "./siem.js";
import { sendTrailToSyslog, syslogNamed } from "./syslog.js";

/** Events in one batch: its syslog line stays under 8 KiB. */
export const BATCH_EVENTS = 25;
/** How long one run sends: the next minute's run takes up from there. */
const RUN_MS = 45_000;
/** The index the batches are read by (migration 0133). */
export const TRAIL_ORDER_INDEX = "audit_events_write_order";

/** One event as a collector gets it. */
export type TrailEntry = {
  id: string;
  /** Its write order, as a decimal text: a bigint. */
  order: string;
  /** When its transaction began, UTC, to the microsecond. */
  at: string;
  action: string;
  userId: string;
  actedAs: string | null;
  /** HMAC-SHA-256 of everything the event holds, under the batch's key. */
  fingerprint: string;
};

export type TrailBatch = {
  source: "anygriddb";
  action: "trail_batch";
  /** 1, 2, 3…: a number missing at the collector is a batch lost. */
  batch: number;
  /** The digest of the batch before, null for the first. */
  previous: string | null;
  /** The identifier of the key the fingerprints were made with. */
  key: string;
  events: TrailEntry[];
  /** SHA-256 of the fields above but `source` and `action`. */
  digest: string;
};

/** An event as the database gives it, all it holds in one text. */
export type TrailRow = Omit<TrailEntry, "fingerprint"> & { content: string };

/**
 * An event's columns, the same text on every server: its time in UTC to
 * the microsecond, its values as PostgreSQL writes JSON.
 */
const AT = sql`to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const TRAIL_ROW = sql`id::text as "id", write_order::text as "order",
  ${AT} as "at", action::text as "action", user_id::text as "userId",
  impersonated_user_id::text as "actedAs",
  json_build_array(id, ${AT}, action, table_id, record_id, catalog_table,
    reason, source, old_value, new_value, write_order, xact_id::text
  )::text as "content"`;

/** The fingerprint of an event's content under a key of the trail. */
export function fingerprint(key: Buffer, content: string): string {
  return createHmac("sha256", key).update(content).digest("hex");
}

/** What a batch's digest covers, in one fixed order. */
export function batchDigest(
  batch: Omit<TrailBatch, "source" | "action" | "digest">,
): string {
  const events = batch.events.map((event) => [
    event.id,
    event.order,
    event.at,
    event.action,
    event.userId,
    event.actedAs,
    event.fingerprint,
  ]);
  return createHash("sha256")
    .update(JSON.stringify([batch.batch, batch.previous, batch.key, events]))
    .digest("hex");
}

/** The batch that follows `previous`, holding these events. */
export function buildBatch(
  rows: readonly TrailRow[],
  key: { id: string; key: Buffer },
  number: number,
  previous: string | null,
): TrailBatch {
  const events = rows.map(({ content, ...event }) => ({
    ...event,
    fingerprint: fingerprint(key.key, content),
  }));
  const fields = { batch: number, previous, key: key.id, events };
  return {
    source: "anygriddb",
    action: "trail_batch",
    ...fields,
    digest: batchDigest(fields),
  };
}

export type ShippingState = {
  shippedOrder: string;
  batch: string;
  digest: string | null;
  horizonOrder: string | null;
  horizonXact: string | null;
};

/**
 * Where the copy stands, made the first time it is asked for: from the
 * newest event then, since the events before were never sent.
 */
async function startingState(db: Database): Promise<ShippingState> {
  await sql`insert into trail_shipping (shipped_order)
    select coalesce(max(write_order), 0) from audit_events
    on conflict (id) do nothing`.execute(db);
  const { rows } =
    await sql<ShippingState>`select shipped_order::text as "shippedOrder",
      batch::text as "batch", digest, horizon_order::text as "horizonOrder",
      horizon_xact::text as "horizonXact"
    from trail_shipping where id`.execute(db);
  const state = rows[0];
  if (!state) throw new Error("trail_shipping has no row");
  return state;
}

/**
 * How far batches may go now. A write order is taken while an event is
 * written, so one taken by a transaction still open can be below one
 * already seen. The newest order is noted with the snapshot's horizon; once
 * every transaction open then has ended, nothing below that order can still
 * appear, and batches may reach it. The transaction's id is taken first,
 * by the trail's column default, before its write order.
 */
export async function safeOrder(
  db: Database,
  state: ShippingState,
): Promise<{ safe: string; state: ShippingState }> {
  const { rows } = await sql<{
    xmin: string;
    xmax: string;
    top: string | null;
  }>`select pg_snapshot_xmin(pg_current_snapshot())::text as "xmin",
      pg_snapshot_xmax(pg_current_snapshot())::text as "xmax",
      (select max(write_order) from audit_events)::text as "top"`.execute(db);
  const now = rows[0];
  if (!now) return { safe: state.shippedOrder, state };
  const noted = state.horizonXact === null ? null : BigInt(state.horizonXact);
  const passed = noted !== null && BigInt(now.xmin) >= noted;
  // A horizon past the cluster's own was noted on another cluster: the
  // database was restored. It is noted again.
  const stale = noted === null || noted > BigInt(now.xmax);
  const safe =
    passed && state.horizonOrder !== null
      ? state.horizonOrder
      : state.shippedOrder;
  if (!passed && !stale) return { safe, state };
  const horizonOrder = now.top ?? state.shippedOrder;
  await sql`update trail_shipping
    set horizon_order = ${horizonOrder}::bigint, horizon_xact = ${now.xmax}::xid8
    where id`.execute(db);
  return { safe, state: { ...state, horizonOrder, horizonXact: now.xmax } };
}

/** The events after `after`, up to `upTo`, in the order they were written. */
async function eventsAfter(
  db: Database,
  after: string,
  upTo: string,
): Promise<TrailRow[]> {
  const { rows } = await sql<TrailRow>`select ${TRAIL_ROW} from audit_events
    where write_order > ${after}::bigint and write_order <= ${upTo}::bigint
    order by write_order limit ${BATCH_EVENTS}`.execute(db);
  return rows;
}

/** Whether the index batches are read by exists and can be used. */
export async function trailOrderIndexed(db: Database): Promise<boolean> {
  const { rows } = await sql<{ valid: boolean }>`select i.indisvalid as "valid"
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where c.relname = ${TRAIL_ORDER_INDEX}`.execute(db);
  return rows.some((row) => row.valid);
}

export type ShipDeps = {
  db: Database;
  key: KeyRing;
  syslog: SyslogCollector | undefined;
  /** Where a batch goes; by default every collector the instance names. */
  send?: (batch: TrailBatch) => Promise<void>;
  runMs?: number;
};

/** Every collector the instance names, or null when it names none. */
async function collectors(
  deps: ShipDeps,
): Promise<((batch: TrailBatch) => Promise<void>) | null> {
  const https = (await loadSiemRow(deps.db)) !== null;
  const syslog = await syslogNamed(deps.db, deps.syslog);
  if (!https && !syslog) return null;
  // A collector that took a batch may get it again when the other failed:
  // the same number, the same content.
  return async (batch) => {
    const body = JSON.stringify(batch);
    if (https) await postToSiem(deps.db, deps.key, body);
    if (syslog) await sendTrailToSyslog(deps.db, deps.syslog, body);
  };
}

/**
 * Sends what the collectors do not have yet, a batch at a time, for at
 * most `runMs`. Answers how many events went. A collector that refuses
 * stops the run, and the next one sends the same batch again.
 */
export async function shipTrail(deps: ShipDeps): Promise<number> {
  if (!(await readSettings(deps.db)).trailToCollector) return 0;
  if (!(await trailOrderIndexed(deps.db))) return 0;
  // From here on every event goes, a collector named now or later.
  let state = await startingState(deps.db);
  const send = deps.send ?? (await collectors(deps));
  if (!send) return 0;
  const until = Date.now() + (deps.runMs ?? RUN_MS);
  let sent = 0;
  while (Date.now() < until) {
    const next = await safeOrder(deps.db, state);
    state = next.state;
    const safe = next.safe;
    if (BigInt(state.shippedOrder) >= BigInt(safe)) break;
    const rows = await eventsAfter(deps.db, state.shippedOrder, safe);
    const last = rows.at(-1)?.order ?? safe;
    let digest = state.digest;
    let batch = state.batch;
    if (rows.length > 0) {
      const made = buildBatch(
        rows,
        currentKey(deps.key, "trail"),
        Number(state.batch) + 1,
        state.digest,
      );
      try {
        await send(made);
      } catch (error) {
        await sql`update trail_shipping set failed_at = now() where id`.execute(
          deps.db,
        );
        throw error;
      }
      digest = made.digest;
      batch = String(made.batch);
      sent += rows.length;
    }
    // Another run that sent the same batch has moved on: this one stops.
    const moved = await sql`update trail_shipping
      set shipped_order = ${last}::bigint, batch = ${batch}::bigint,
          digest = ${digest}, failed_at = null,
          shipped_at = case when ${rows.length > 0}::boolean then now() else shipped_at end
      where id and batch = ${state.batch}::bigint
        and shipped_order = ${state.shippedOrder}::bigint`.execute(deps.db);
    if (moved.numAffectedRows !== 1n) break;
    state = { ...state, shippedOrder: last, batch, digest };
  }
  return sent;
}

export type TrailShippingStatus = {
  on: boolean;
  /** A collector is named: the HTTPS one, or syslog. */
  collector: boolean;
  /** The index batches are read by; a long trail gets it after the start. */
  indexed: boolean;
  batch: number;
  shippedAt: string | null;
  failedAt: string | null;
  /** Events written and not sent yet; null when it cannot be counted cheaply. */
  waiting: number | null;
};

/** What Administration shows of the copy. */
export async function trailShippingStatus(
  db: Database,
  syslog: SyslogCollector | undefined,
): Promise<TrailShippingStatus> {
  const [settings, siem, named, indexed, state] = await Promise.all([
    readSettings(db),
    loadSiemRow(db),
    syslogNamed(db, syslog),
    trailOrderIndexed(db),
    db
      .selectFrom("trailShipping")
      .selectAll()
      .where("id", "=", true)
      .executeTakeFirst(),
  ]);
  let waiting: number | null = null;
  if (indexed && state) {
    const { rows } = await sql<{
      waiting: string;
    }>`select count(*)::text as "waiting"
      from audit_events where write_order > ${state.shippedOrder}::bigint`.execute(
      db,
    );
    waiting = Number(rows[0]?.waiting ?? 0);
  }
  return {
    on: settings.trailToCollector,
    collector: siem !== null || named,
    indexed,
    batch: state ? Number(state.batch) : 0,
    shippedAt: state?.shippedAt?.toISOString() ?? null,
    failedAt: state?.failedAt?.toISOString() ?? null,
    waiting,
  };
}
