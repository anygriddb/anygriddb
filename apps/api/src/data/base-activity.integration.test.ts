/**
 * A base's activity, read by its members, against a real database: each
 * reads what was done in the tables and fields they see, by name, and
 * nothing of a field hidden from them or of a table whose rows a rule
 * keeps from them.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import { createTestDatabase } from "../test-database.js";
import { setTableAcl } from "./acl.js";
import { withAudit } from "./audit-context.js";
import { baseActivity } from "./base-activity.js";
import { loadEngine } from "./engine.js";
import { insertRows, updateRows } from "./rows.js";
import {
  addColumn,
  insertBase,
  insertTable,
  updateTable,
} from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");

describe("a base's activity", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let ada = "";
  let bob = "";
  let baseId = "";
  let clients = "";
  let orders = "";

  async function write(tableId: string) {
    const { engine, rows } = await loadEngine(db, tableId, () => true);
    const physical = rows.tables.find((table) => table.id === tableId);
    if (!physical) throw new Error("no table");
    const context = {
      userId: owner,
      tableId,
      physicalName: physical.physicalName,
      baseId,
      reason: null,
      source: "test",
    };
    return {
      insert: (values: Record<string, string>) =>
        insertRows(db, engine, context, [values]),
      update: (rowId: string, values: Record<string, string>) =>
        updateRows(db, engine, context, [{ rowId, values }]),
    };
  }

  async function read(userId: string, before?: string, limit = 50) {
    return baseActivity(
      db,
      { userId, bindings: await loadBindings(db, userId) },
      { baseId, limit, ...(before ? { before } : {}) },
    );
  }

  beforeAll(async () => {
    const created = await createTestDatabase("base_activity");
    db = created.db;
    close = created.close;
    [owner, ada, bob] = (
      await db
        .insertInto("users")
        .values([
          { email: `owner-${suffix}@example.com`, displayName: "Owner" },
          { email: `ada-${suffix}@example.com`, displayName: "Ada" },
          { email: `bob-${suffix}@example.com`, displayName: "Bob" },
        ])
        .returning("id")
        .execute()
    ).map((row) => row.id) as [string, string, string];
    baseId = (await insertBase(db, owner, { name: "Ventes" })).id;
    await withAudit(db, { userId: owner }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values([
          { userId: ada, role: "editor", scope: "base", scopeId: baseId },
          { userId: bob, role: "viewer", scope: "base", scopeId: baseId },
        ])
        .execute(),
    );
    clients = (
      await insertTable(db, owner, {
        baseId,
        name: "Clients",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "margin", label: "Margin", fieldType: "text" },
        ],
      })
    ).id;
    orders = (
      await insertTable(db, owner, {
        baseId,
        name: "Orders",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    // Ada does not see the margin; Bob sees only some orders.
    await setTableAcl(db, owner, {
      tableId: clients,
      userId: ada,
      rowFilter: null,
      columns: [
        { column: "name", access: "write" },
        { column: "margin", access: "hide" },
      ],
    });
    await setTableAcl(db, owner, {
      tableId: orders,
      userId: bob,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "title", op: "is", value: "Mine" }],
      },
      columns: [],
    });

    const clientRows = await write(clients);
    const [acme] = await clientRows.insert({ name: "Acme", margin: "12" });
    if (!acme) throw new Error("no row");
    await clientRows.update(acme, { name: "Acme Corp", margin: "15" });
    await clientRows.update(acme, { margin: "20" });
    await addColumn(db, owner, clients, { label: "Notes", fieldType: "text" });
    await updateTable(db, owner, { tableId: orders, name: "Purchases" });
    await (await write(orders)).insert({ title: "Mine" });
  });

  afterAll(async () => {
    await close?.();
  });

  it("tells a manager everything, newest first, by field name and row", async () => {
    const { events, next } = await read(owner);
    expect(next).toBeNull();
    expect(
      events.map((event) => [
        event.kind,
        event.table,
        event.fields,
        event.field,
        event.before,
      ]),
    ).toEqual([
      ["row_added", "Purchases", [], null, null],
      ["table_renamed", "Purchases", [], null, "Orders"],
      ["field_added", "Clients", [], "Notes", null],
      ["row_changed", "Clients", ["Margin"], null, null],
      ["row_changed", "Clients", ["Margin", "Name"], null, null],
      ["row_added", "Clients", [], null, null],
      // Each table's fields came with it: its creation tells them.
      ["table_added", "Purchases", [], null, null],
      ["table_added", "Clients", [], null, null],
    ]);
    // The row by its primary field as it reads now, and who did it.
    expect(events.at(-3)).toMatchObject({
      row: "Acme Corp",
      by: { name: "Owner" },
    });
  });

  it("leaves out of a member's activity the field hidden from them", async () => {
    const { events } = await read(ada);
    const clientsEvents = events.filter((event) => event.table === "Clients");
    // The edit of the margin alone is not told; the other loses it.
    expect(
      clientsEvents.map((event) => [event.kind, event.fields, event.field]),
    ).toEqual([
      ["row_changed", ["Name"], null],
      ["row_added", [], null],
      ["table_added", [], null],
    ]);
    // A field added later is hidden too, while their rules name the others.
    expect(events.some((event) => event.field === "Notes")).toBe(false);
  });

  it("leaves out a table whose rows a rule keeps from the reader", async () => {
    const { events } = await read(bob);
    expect(new Set(events.map((event) => event.table))).toEqual(
      new Set(["Clients"]),
    );
  });

  it("reads page after page, none twice and none missed", async () => {
    const all = (await read(owner)).events.map((event) => event.id);
    const pages: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const read2 = await read(owner, before, 2);
      pages.push(...read2.events.map((event) => event.id));
      if (!read2.next) break;
      before = read2.next;
    }
    expect(pages).toEqual(all);
  });
});
