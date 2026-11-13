/**
 * Exports on the change trail (ROADMAP #31), against a real database:
 * what the trail says of each, and what it leaves alone.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceAudit } from "../admin.js";
import { auditEventsCsv } from "../admin-control.js";
import { createTestDatabase } from "../test-database.js";
import { recordExport } from "./export-audit.js";
import { insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");

describe("exports on the change trail", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let baseId = "";
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("export_audit");
    db = created.db;
    close = created.close;
    owner = (
      await db
        .insertInto("users")
        .values({ email: `owner-${suffix}@example.org`, displayName: "Olive" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    baseId = (await insertBase(db, owner, { name: "Ventes" })).id;
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

  it("says who exported what, by its kind, format, and rows, and never a value", async () => {
    await recordExport(db, {
      userId: owner,
      tableId,
      source: "api",
      export: { kind: "view", format: "xlsx", rows: 1_200 },
    });
    await recordExport(db, {
      userId: owner,
      source: "web",
      export: { kind: "base", format: "zip", baseId },
    });
    await recordExport(db, {
      userId: owner,
      source: "web",
      export: { kind: "access_report", format: "csv" },
    });

    const { events } = await instanceAudit(db, { action: "export", limit: 10 });
    expect(
      events.map((event) => ({
        who: event.userName,
        base: event.baseName,
        table: event.tableName,
        source: event.source,
        fields: event.fields,
        exported: event.exported,
      })),
    ).toEqual([
      {
        who: "Olive",
        base: null,
        table: null,
        source: "web",
        fields: [],
        exported: { kind: "access_report", format: "csv", rows: null },
      },
      {
        // A base's file names its base, though no table of it.
        who: "Olive",
        base: "Ventes",
        table: null,
        source: "web",
        fields: [],
        exported: { kind: "base", format: "zip", rows: null },
      },
      {
        who: "Olive",
        base: "Ventes",
        table: "Clients",
        source: "api",
        fields: [],
        exported: { kind: "view", format: "xlsx", rows: 1_200 },
      },
    ]);
    const lines = auditEventsCsv(events).trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/,fields,exported$/);
    expect(lines[3]).toMatch(/,view xlsx 1200 rows$/);
    expect(lines[1]).toMatch(/,access_report csv$/);
  });

  it("leaves the other events as they were: fields changed, nothing exported", async () => {
    const { events } = await instanceAudit(db, { tableId, limit: 50 });
    const changes = events.filter((event) => event.action !== "export");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((event) => event.exported === null)).toBe(true);
  });
});
