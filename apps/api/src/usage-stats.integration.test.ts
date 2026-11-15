/**
 * Usage figures (ROADMAP #40): live counts and the daily snapshot.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertBase, insertTable } from "./data/schema-ops.js";
import { createTestDatabase } from "./test-database.js";
import {
  countUsageNow,
  purgeUsageDaily,
  readUsage,
  snapshotUsage,
} from "./usage-stats.js";

const suffix = randomBytes(6).toString("hex");
const now = new Date("2026-11-15T12:00:00Z");

describe("usage figures", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin = "";
  let quiet = "";

  beforeAll(async () => {
    const created = await createTestDatabase("usage_stats");
    db = created.db;
    close = created.close;
    admin = (
      await db
        .insertInto("users")
        .values({
          email: `active-${suffix}@example.org`,
          displayName: "Active",
          isAdmin: true,
          activeAt: now,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    quiet = (
      await db
        .insertInto("users")
        .values({
          email: `quiet-${suffix}@example.org`,
          displayName: "Quiet",
          activeAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const baseId = (await insertBase(db, admin, { name: "Sales" })).id;
    const tableId = (
      await insertTable(db, admin, {
        baseId,
        name: "Clients",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    await db
      .insertInto("auditEvents")
      .values({
        userId: admin,
        action: "update",
        tableId,
        recordId: null,
        oldValue: { name: "a" },
        newValue: { name: "b" },
        reason: "edit",
        source: "web",
        occurredAt: now,
      })
      .execute();
    // A base with no recent trail event must not count as active.
    await insertBase(db, admin, { name: "Idle" });
    expect(quiet).toBeTruthy();
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("counts the active account and the base with a recent trail event", async () => {
    const counts = await countUsageNow(db, now);
    expect(counts.accountsActive30d).toBeGreaterThanOrEqual(1);
    expect(counts.accountsTotal).toBeGreaterThanOrEqual(2);
    expect(counts.basesActive30d).toBe(1);
    expect(counts.basesTotal).toBeGreaterThanOrEqual(2);
  });

  it("writes today's snapshot and returns it on a Health read", async () => {
    const snap = await snapshotUsage(db, now);
    expect(snap.day).toBe("2026-11-15");
    expect(snap.basesActive30d).toBe(1);
    const again = await snapshotUsage(db, now);
    expect(again.basesActive30d).toBe(1);
    const figures = await readUsage(db, now);
    expect(figures.current.basesActive30d).toBe(1);
    const today = figures.trend.find((row) => row.day === "2026-11-15");
    expect(today?.basesActive30d).toBe(1);
    expect(today?.accountsActive30d).toBeGreaterThanOrEqual(1);
  });

  it("purges daily rows older than the trend window", async () => {
    await sql`
      insert into usage_daily (
        day, accounts_active_30d, bases_active_30d, accounts_total, bases_total
      ) values ('2025-01-01'::date, 0, 0, 0, 0)
      on conflict do nothing
    `.execute(db);
    expect(await purgeUsageDaily(db, now)).toBeGreaterThanOrEqual(1);
  });
});
