/**
 * The change trail's copy at the collectors (ADR 0120), on a real
 * database: what is sent, when, and what the copy shows once the trail was
 * rewritten by the role that owns it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "@anygriddb/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { createTestDatabase } from "../test-database.js";
import {
  BATCH_EVENTS,
  shipTrail,
  trailShippingStatus,
  type TrailBatch,
} from "./trail-shipping.js";
import { verifyTrail } from "./trail-verify.js";

describe("the change trail's copy at the collectors", () => {
  const ring = keyRing(randomBytes(32), "test");
  const sent: TrailBatch[] = [];
  let db: Database;
  let pool: pg.Pool;
  let ownerPool: pg.Pool;
  let close: (() => Promise<void>) | undefined;
  let alice = "";
  let bob = "";
  /** Events from before the write order, oldest first (migration 0128). */
  const early: string[] = [];

  const account = async (name: string) =>
    (
      await db
        .insertInto("users")
        .values({
          email: `${name}-${randomBytes(4).toString("hex")}@example.org`,
          displayName: name,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  const write = async (
    userId: string,
    client: pg.Pool | pg.PoolClient = pool,
  ) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into audit_events (user_id, action, reason)
       values ($1, 'update', $2) returning id::text as id`,
      [userId, randomUUID()],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("no event");
    return id;
  };
  const ship = () =>
    shipTrail({
      db,
      key: ring,
      syslog: undefined,
      send: async (batch) => {
        sent.push(batch);
      },
      runMs: 10_000,
    });
  const sentIds = () =>
    sent.flatMap((batch) => batch.events.map((event) => event.id));
  /** A first run notes how far it may go; once no transaction of the
   * cluster open then is still open, a later one goes. */
  const shipUntil = async (sentAll: readonly string[]) => {
    const done = () => sentAll.every((id) => sentIds().includes(id));
    for (let tries = 0; tries < 100 && !done(); tries += 1) {
      await ship();
      if (!done()) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(sentIds()).toEqual(expect.arrayContaining([...sentAll]));
  };
  const file = (batches: readonly TrailBatch[] = sent) =>
    batches.map((batch) => JSON.stringify(batch)).join("\n");

  beforeAll(async () => {
    const created = await createTestDatabase("trail_copy");
    db = created.db;
    pool = created.pool;
    ownerPool = created.owner.pool;
    close = created.close;
    alice = await account("Alice");
    bob = await account("Bob");
    // Only the trail's owner can still write an event without an order.
    for (const daysAgo of [3, 2, 1]) {
      const { rows } = await ownerPool.query<{ id: string }>(
        `insert into audit_events
           (user_id, action, reason, occurred_at, write_order, xact_id)
         values ($1, 'update', $2, now() - make_interval(days => $3), null, null)
         returning id::text as id`,
        [alice, randomUUID(), daysAgo],
      );
      early.push(rows[0]?.id ?? "");
    }
    await pool.query(
      `insert into instance_settings (key, value, updated_by)
       values ('trailToCollector', 'true', $1)`,
      [alice],
    );
  });

  afterAll(async () => {
    await close?.();
  });

  it("sends the whole trail: the events from before the write order by date, then the others in order", async () => {
    const before = await write(alice);
    // Turned on with no collector named yet: it begins from the start all the same.
    expect(await shipTrail({ db, key: ring, syslog: undefined })).toBe(0);
    const after = await write(bob);
    await shipUntil([...early, before, after]);
    expect(sentIds().slice(0, early.length)).toEqual(early);
    expect(sent[0]?.events.every((event) => event.order === null)).toBe(true);
    const ordered = sentIds().slice(early.length);
    expect(ordered.indexOf(before)).toBeGreaterThanOrEqual(0);
    expect(ordered.indexOf(before)).toBeLessThan(ordered.indexOf(after));
    expect(sent.map((batch) => batch.batch)).toEqual(
      sent.map((_, index) => index + 1),
    );
  });

  it("sends every event, in the order written, in chained batches", async () => {
    const from = sent.length;
    const before = sent[from - 1];
    if (!before) throw new Error("a batch before");
    const written: string[] = [];
    for (let index = 0; index < BATCH_EVENTS + 5; index += 1) {
      written.push(await write(index % 2 === 0 ? alice : bob));
    }
    await shipUntil(written);
    const batches = sent.slice(from);
    expect(
      batches.flatMap((batch) => batch.events.map((event) => event.id)),
    ).toEqual(written);
    expect(batches.map((batch) => batch.batch)).toEqual([
      before.batch + 1,
      before.batch + 2,
    ]);
    expect(batches[0]?.previous).toBe(before.digest);
    expect(batches[1]?.previous).toBe(batches[0]?.digest);
    expect(batches[0]?.key).toBe("test");
    expect((await ship()) + (await ship())).toBe(0);
  });

  it("waits for a transaction still open below what it would send", async () => {
    const open = await pool.connect();
    try {
      await open.query("begin");
      const late = await write(alice, open);
      const early = await write(bob);
      await ship();
      await ship();
      expect(sentIds()).not.toContain(early);
      await open.query("commit");
      await shipUntil([late, early]);
      expect(sentIds().slice(-2)).toEqual([late, early]);
    } finally {
      open.release();
    }
  });

  it("finds a copy that matches, and takes an erasure for one", async () => {
    const carol = await account("Carol");
    await shipUntil([await write(carol)]);
    await pool.query("select ag_erase_account($1)", [carol]);
    const report = await verifyTrail(db, ring, file());
    expect(report.findings).toEqual([]);
    expect(report.erased).toBe(1);
    expect(report.matched).toBe(sentIds().length - 1);
  });

  it("names what the owner of the trail rewrote, and the batches lost", async () => {
    const full = sent.find((batch) => batch.events.length === BATCH_EVENTS);
    const [altered, deleted, reassigned] = full?.events ?? [];
    if (!full || !altered || !deleted || !reassigned) {
      throw new Error("a full batch");
    }
    const owner = await ownerPool.connect();
    try {
      await owner.query("begin");
      await owner.query("alter table audit_events disable trigger user");
      await owner.query(
        "update audit_events set reason = 'nothing happened' where id = any($1::uuid[])",
        [[early[0], altered.id]],
      );
      await owner.query("delete from audit_events where id = $1", [deleted.id]);
      await owner.query("update audit_events set user_id = $1 where id = $2", [
        reassigned.userId === alice ? bob : alice,
        reassigned.id,
      ]);
      await owner.query("alter table audit_events enable trigger user");
      await owner.query("commit");
    } finally {
      owner.release();
    }
    const report = await verifyTrail(db, ring, file());
    expect(report.findings).toEqual([
      { kind: "event_altered", batch: 1, id: early[0] },
      { kind: "event_altered", batch: full.batch, id: altered.id },
      { kind: "event_deleted", batch: full.batch, id: deleted.id },
      { kind: "author_changed", batch: full.batch, id: reassigned.id },
    ]);
    const lost = sent.find((batch) => batch.batch === full.batch + 1);
    const kept = sent.filter((batch) => batch !== lost);
    const gaps = await verifyTrail(db, ring, file(kept));
    expect(gaps.findings).toContainEqual({
      kind: "batch_missing",
      batch: full.batch + 1,
    });
    expect(
      gaps.findings.filter((finding) => finding.kind === "event_not_sent"),
    ).toEqual(
      lost?.events.map((event) => ({ kind: "event_not_sent", id: event.id })),
    );
  });

  it("names an early event no batch carried", async () => {
    const [first, ...rest] = sent;
    if (!first) throw new Error("the first batch");
    const thinned = {
      ...first,
      events: first.events.filter((event) => event.id !== early[1]),
    };
    const report = await verifyTrail(db, ring, file([thinned, ...rest]));
    expect(report.findings).toContainEqual({ kind: "batch_altered", batch: 1 });
    expect(report.findings).toContainEqual({
      kind: "event_not_sent",
      id: early[1],
    });
  });

  it("says how far it went, and what waits", async () => {
    expect(await trailShippingStatus(db, undefined)).toMatchObject({
      on: true,
      collector: false,
      indexed: true,
      batch: sent.at(-1)?.batch,
      waiting: 0,
    });
    await write(alice);
    expect((await trailShippingStatus(db, undefined)).waiting).toBe(1);
  });
});
