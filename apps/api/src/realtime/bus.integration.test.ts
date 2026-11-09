import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@anygriddb/db";
import type pg from "pg";
import { createTestDatabase } from "../test-database.js";
import { PgBus } from "./bus.js";
import { acquireLock, purgeLocks } from "./locks.js";

describe("realtime on PostgreSQL", () => {
  let db: Database;
  let pool: pg.Pool;
  let url = "";
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const created = await createTestDatabase("bus");
    db = created.db;
    pool = created.pool;
    url = created.url;
    close = created.close;
  });

  afterAll(async () => {
    await close?.();
  });

  it("carries messages between two processes, many per commit", async () => {
    const errors: unknown[] = [];
    const sender = new PgBus(pool, url, (error) => errors.push(error));
    const receiver = new PgBus(pool, url, (error) => errors.push(error));
    await receiver.start();
    const received: Array<[string, string]> = [];
    const all = new Promise<void>((resolve) => {
      receiver.onMessage((channel, message) => {
        received.push([channel, message]);
        if (received.length === 3) resolve();
      });
    });
    await Promise.all([
      sender.publish("grid:a", JSON.stringify({ type: "stale", channel: "a" })),
      sender.publish("grid:b", JSON.stringify({ type: "stale", channel: "b" })),
      sender.publish(
        "grid:a",
        JSON.stringify({ type: "catalog", channel: "a" }),
      ),
    ]);
    await all;
    expect(received.map(([channel]) => channel)).toEqual([
      "grid:a",
      "grid:b",
      "grid:a",
    ]);
    expect(receiver.listening()).toBe(true);
    await receiver.close();
    await sender.close();
    expect(errors).toEqual([]);
  });

  it("drops a message that would not fit, and says so", async () => {
    const logged: string[] = [];
    const bus = new PgBus(pool, url, (_error, message) => logged.push(message));
    await bus.publish("grid:a", "x".repeat(9_000));
    expect(logged).toEqual(["realtime message too large, dropped"]);
    await bus.close();
  });

  it("gives a lock to one owner until it expires", async () => {
    const key = "cell:t1:r1:name";
    expect(await acquireLock(db, { key, owner: "ana", ttlSeconds: 30 })).toBe(
      true,
    );
    // Racing for a held lock: only its owner renews it.
    const [first, second] = await Promise.all([
      acquireLock(db, { key, owner: "bob", ttlSeconds: 30 }),
      acquireLock(db, { key, owner: "ana", ttlSeconds: 30 }),
    ]);
    expect([first, second]).toEqual([false, true]);
    await db
      .updateTable("ephemeralLocks")
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where("key", "=", key)
      .execute();
    expect(await acquireLock(db, { key, owner: "bob", ttlSeconds: 30 })).toBe(
      true,
    );
    await purgeLocks(db);
    await expect(
      acquireLock(db, { key, owner: "bob", ttlSeconds: 0 }),
    ).rejects.toThrow("Invalid lock ttl");
  });
});
