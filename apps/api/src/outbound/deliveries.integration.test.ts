/**
 * The one journal of deliveries (ADR 0125): what an emitter adds is sent
 * by its origin, retried on one schedule, given up and said so, tried
 * again when a person asks, swept when its attempt was lost, and purged.
 */
import { randomBytes } from "node:crypto";
import type { Database, DeliveryRow } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withAudit } from "../data/audit-context.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { createTestDatabase } from "../test-database.js";
import {
  addDeliveries,
  purgeDeliveries,
  retryDelivery,
  runDelivery,
  sweepDeliveries,
  type AttemptOutcome,
  type Destinations,
} from "./deliveries.js";

const suffix = randomBytes(6).toString("hex");

type Heard = Array<[string, string, string?]>;

/** Destinations that answer as told, and note what they were told after. */
function destinations(outcome: AttemptOutcome, heard: Heard): Destinations {
  const destination = {
    attempt: () => Promise.resolve(outcome),
    delivered: (delivery: DeliveryRow) => {
      heard.push(["delivered", delivery.id]);
      return Promise.resolve();
    },
    retrying: (delivery: DeliveryRow, error: string) => {
      heard.push(["retrying", delivery.id, error]);
      return Promise.resolve();
    },
    gaveUp: (delivery: DeliveryRow, error: string) => {
      heard.push(["gaveUp", delivery.id, error]);
      return Promise.resolve();
    },
  };
  return { webhook: destination, integration: destination };
}

describe("the journal of deliveries", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let webhookId = "";
  let otherWebhookId = "";
  let channelId = "";

  async function jobsOf(deliveryId: string): Promise<string[]> {
    const { rows } = await sql<{ key: string }>`
      select key from graphile_worker.jobs
       where task_identifier = 'delivery_attempt'
         and key like ${`delivery:${deliveryId}:%`}
       order by key
    `.execute(db);
    return rows.map((row) => row.key);
  }

  async function delivery(id: string) {
    return db
      .selectFrom("deliveries")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  async function added(payload: unknown = { id: "event" }): Promise<string> {
    const [id] = await addDeliveries(db, [
      { webhookId, event: "insert", payload },
    ]);
    if (!id) throw new Error("not added");
    return id;
  }

  beforeAll(async () => {
    const created = await createTestDatabase("deliveries");
    db = created.db;
    close = created.close;
    const { id: owner } = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.org`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const { id: baseId } = await insertBase(db, owner, { name: "Hooks" });
    const table = await insertTable(db, owner, {
      baseId,
      name: "Orders",
      columns: [{ name: "title", label: "Title", fieldType: "text" }],
    });
    const hooks = await withAudit(
      db,
      { userId: owner, tableId: table.id, source: "web" },
      (tx) =>
        tx
          .insertInto("webhooks")
          .values(
            ["one", "other"].map((name) => ({
              tableId: table.id,
              name,
              kind: "http" as const,
              target: "https://hooks.example.org/in",
              events: ["insert"],
              secretCiphertext: Buffer.from("sealed"),
              secretNonce: Buffer.from("nonce"),
            })),
          )
          .returning("id")
          .execute(),
    );
    webhookId = hooks[0]?.id ?? "";
    otherWebhookId = hooks[1]?.id ?? "";
    const channel = await db
      .insertInto("instanceIntegrations")
      .values({ name: "Ops", provider: "ntfy" })
      .returning("id")
      .executeTakeFirstOrThrow();
    channelId = channel.id;
  });

  beforeEach(async () => {
    await db.deleteFrom("deliveries").execute();
  });

  afterAll(async () => {
    await close?.();
  });

  it("adds a delivery with its first attempt, and a channel's event once", async () => {
    const id = await added();
    expect(await jobsOf(id)).toEqual([`delivery:${id}:0`]);
    const event = {
      integrationId: channelId,
      eventId: "33333333-3333-4333-8333-333333333333",
      event: "job.failed",
      payload: { kind: "export" },
    };
    expect(await addDeliveries(db, [event])).toHaveLength(1);
    expect(await addDeliveries(db, [event])).toEqual([]);
    // A delivery goes to a webhook or to a channel, never to both or none.
    await expect(
      db.insertInto("deliveries").values({ event: "insert" }).execute(),
    ).rejects.toThrow(/deliveries_one_origin/);
  });

  it("keeps nothing of what it sent once delivered", async () => {
    const id = await added();
    const heard: Heard = [];
    await runDelivery(db, destinations({ sent: true, status: 204 }, heard), id);
    expect(await delivery(id)).toMatchObject({
      status: "success",
      attempts: 1,
      responseStatus: 204,
      payload: null,
      finishedAt: expect.any(Date),
    });
    expect(heard).toEqual([["delivered", id]]);
    // Sent once: a second attempt finds nothing pending.
    await runDelivery(db, destinations({ sent: true, status: 204 }, heard), id);
    expect(heard).toHaveLength(1);
  });

  it("tries again on its schedule, then gives up and says so", async () => {
    const id = await added();
    const heard: Heard = [];
    const failing = destinations(
      { sent: false, status: 503, error: "HTTP 503" },
      heard,
    );
    await runDelivery(db, failing, id);
    expect(await delivery(id)).toMatchObject({
      status: "pending",
      attempts: 1,
      responseStatus: 503,
      error: "HTTP 503",
    });
    expect(await jobsOf(id)).toEqual([`delivery:${id}:0`, `delivery:${id}:1`]);
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await runDelivery(db, failing, id);
    }
    expect(await delivery(id)).toMatchObject({
      status: "failed",
      attempts: 4,
      nextAttemptAt: null,
      // Kept, so that a person can send it again.
      payload: { id: "event" },
    });
    expect(heard.map(([what]) => what)).toEqual([
      "retrying",
      "retrying",
      "retrying",
      "gaveUp",
    ]);
  });

  it("counts no attempt when its destination is off", async () => {
    const id = await added();
    const heard: Heard = [];
    await runDelivery(
      db,
      destinations({ refused: "Webhook disabled" }, heard),
      id,
    );
    expect(await delivery(id)).toMatchObject({
      status: "failed",
      attempts: 0,
      error: "Webhook disabled",
    });
    expect(heard).toEqual([]);
  });

  it("sends again what gave up, from its first attempt, where it may", async () => {
    const id = await added();
    await runDelivery(db, destinations({ refused: "off" }, []), id);
    // Not from another webhook's page.
    await expect(
      retryDelivery(db, id, { webhookId: otherWebhookId }),
    ).rejects.toMatchObject({ code: "invalid_delivery" });
    await retryDelivery(db, id, { webhookId });
    expect(await delivery(id)).toMatchObject({
      status: "pending",
      attempts: 0,
      finishedAt: null,
    });
    // Once delivered, there is nothing left to send again.
    await runDelivery(db, destinations({ sent: true, status: 200 }, []), id);
    await expect(retryDelivery(db, id)).rejects.toMatchObject({
      code: "invalid_delivery",
    });
  });

  it("queues again an attempt long overdue, and purges the old", async () => {
    const late = await added();
    const due = await added();
    await db
      .updateTable("deliveries")
      .set({ nextAttemptAt: new Date(Date.now() - 60 * 60_000) })
      .where("id", "=", late)
      .execute();
    expect(await sweepDeliveries(db)).toBe(1);
    expect(await jobsOf(late)).toEqual([`delivery:${late}:0`]);
    await db
      .updateTable("deliveries")
      .set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) })
      .where("id", "=", late)
      .execute();
    await purgeDeliveries(db);
    const left = await db.selectFrom("deliveries").select("id").execute();
    expect(left.map((row) => row.id)).toEqual([due]);
  });
});
