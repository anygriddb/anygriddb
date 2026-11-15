/**
 * Opens on the change trail (ROADMAP #31), against a real database: off
 * until turned on, then one event per person and table in an hour.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceAudit } from "../admin.js";
import { createTestDatabase } from "../test-database.js";
import { insertBase, insertTable, updateTable } from "./schema-ops.js";
import { recordTableOpen } from "./table-open-audit.js";

const suffix = randomBytes(6).toString("hex");

describe("opens on the change trail", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let other = "";
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("table_open_audit");
    db = created.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        { email: `open-${suffix}@example.org`, displayName: "Olive" },
        { email: `open-other-${suffix}@example.org`, displayName: "Otto" },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    other = people[1]?.id ?? "";
    const baseId = (await insertBase(db, owner, { name: "Reads" })).id;
    tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "Clients",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("writes nothing while the table leaves opens off", async () => {
    expect(
      await recordTableOpen(db, {
        userId: owner,
        tableId,
        source: "web",
      }),
    ).toBe(false);
    const { events } = await instanceAudit(db, { action: "open", limit: 10 });
    expect(events).toEqual([]);
  });

  it("writes one open when turned on, then none again in the hour", async () => {
    await updateTable(db, owner, { tableId, trailReads: true });
    expect(
      await recordTableOpen(db, {
        userId: owner,
        tableId,
        source: "web",
      }),
    ).toBe(true);
    expect(
      await recordTableOpen(db, {
        userId: owner,
        tableId,
        source: "web",
      }),
    ).toBe(false);
    expect(
      await recordTableOpen(db, {
        userId: other,
        tableId,
        source: "api",
      }),
    ).toBe(true);

    const { events } = await instanceAudit(db, { action: "open", limit: 10 });
    expect(
      events.map((event) => ({
        who: event.userName,
        table: event.tableName,
        source: event.source,
        action: event.action,
      })),
    ).toEqual([
      {
        who: "Otto",
        table: "Clients",
        source: "api",
        action: "open",
      },
      {
        who: "Olive",
        table: "Clients",
        source: "web",
        action: "open",
      },
    ]);
  });
});
