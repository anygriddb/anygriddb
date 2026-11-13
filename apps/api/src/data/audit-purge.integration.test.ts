/**
 * The change trail kept for a time (ADR 0069), against a real database:
 * what the purge deletes, what it writes, and what nothing may delete.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceAudit } from "../admin.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { purgeAuditEvents } from "./audit-purge.js";
import { ERASED_USER_ID } from "./erasure.js";
import { insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");
const now = new Date("2026-11-13T03:23:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

describe("the change trail kept for a time", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin = "";
  let tableId = "";

  /** An event of the table's trail, written as its day was. */
  const event = (days: number, reason: string) =>
    db
      .insertInto("auditEvents")
      .values({
        userId: admin,
        action: "update",
        tableId,
        recordId: null,
        oldValue: { name: "before" },
        newValue: { name: "after" },
        reason,
        source: "web",
        occurredAt: daysAgo(days),
      })
      .execute();
  const reasons = async () =>
    (
      await db
        .selectFrom("auditEvents")
        .select("reason")
        .where("tableId", "=", tableId)
        .where("action", "=", "update")
        .orderBy("occurredAt", "asc")
        .execute()
    ).map((row) => row.reason);

  beforeAll(async () => {
    const created = await createTestDatabase("audit_purge");
    db = created.db;
    close = created.close;
    admin = (
      await db
        .insertInto("users")
        .values({
          email: `admin-${suffix}@example.org`,
          displayName: "Ada Admin",
          isAdmin: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const baseId = (await insertBase(db, admin, { name: "Ventes" })).id;
    tableId = (
      await insertTable(db, admin, {
        baseId,
        name: "Clients",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    await event(800, "two years ago");
    await event(400, "last year");
    await event(100, "this year");
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("deletes nothing while the trail is kept for ever", async () => {
    expect(await purgeAuditEvents(db, 0, now)).toBe(0);
    expect(await reasons()).toEqual([
      "two years ago",
      "last year",
      "this year",
    ]);
  });

  it("deletes what is older, and says so on the trail under who chose", async () => {
    await writeSettings(db, admin, { auditRetentionDays: 365 });
    expect(await purgeAuditEvents(db, 365, now)).toBe(2);
    expect(await reasons()).toEqual(["this year"]);

    const { events } = await instanceAudit(db, { action: "purge", limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userName: "Ada Admin",
      source: "retention",
      fields: [],
      exported: null,
      purged: { events: 2, before: daysAgo(365).toISOString() },
    });

    // The day after, nothing is older: nothing is deleted, nothing said.
    expect(await purgeAuditEvents(db, 365, now)).toBe(0);
    expect(
      (await instanceAudit(db, { action: "purge", limit: 5 })).events,
    ).toHaveLength(1);
  });

  it("stands under the erased account once who chose has left", async () => {
    await db
      .updateTable("instanceSettings")
      .set({ updatedBy: null })
      .where("key", "=", "auditRetentionDays")
      .execute();
    await event(500, "older again");
    expect(await purgeAuditEvents(db, 365, now)).toBe(1);
    const last = await db
      .selectFrom("auditEvents")
      .select("userId")
      .where("action", "=", "purge")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(last.userId).toBe(ERASED_USER_ID);
  });

  it("lets nothing else delete from the trail, and nothing at all delete a signature", async () => {
    await expect(
      db.deleteFrom("auditEvents").where("tableId", "=", tableId).execute(),
    ).rejects.toThrow(/Audit immutable/);
    await expect(
      db
        .updateTable("auditEvents")
        .set({ reason: "rewritten" })
        .where("tableId", "=", tableId)
        .execute(),
    ).rejects.toThrow(/Audit immutable/);

    // Even behind the purge's own flag, a signature stays.
    await db
      .insertInto("rowSignatures")
      .values({
        tableId,
        recordId: "00000000-0000-4000-8000-000000000001",
        userId: admin,
        displayName: "Ada Admin",
        meaning: "approved",
      })
      .execute();
    await expect(
      db.transaction().execute(async (tx) => {
        await sql`select set_config('anygrid.purge_audit', 'on', true)`.execute(
          tx,
        );
        await tx.deleteFrom("rowSignatures").execute();
      }),
    ).rejects.toThrow(/Audit immutable/);
    expect(
      await db.selectFrom("rowSignatures").select("id").execute(),
    ).toHaveLength(1);
  });
});
