/**
 * The structure of a base leaves an event on the change trail, under its
 * author's name: the base, the views everyone shares, dashboards and
 * their widgets, folders. What only arranges the screen leaves none, nor
 * does a person's own view.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instanceAudit } from "../admin.js";
import { createTestDatabase } from "../test-database.js";
import {
  createDashboard,
  layoutWidgets,
  updateDashboard,
  upsertWidget,
} from "./dashboards.js";
import { loadEngine } from "./engine.js";
import { createFolder, reorderFolders } from "./folders.js";
import {
  insertBase,
  insertTable,
  updateBase,
  updateTable,
} from "./schema-ops.js";
import { restoreBase, restoreView, trashBase } from "./trash.js";
import {
  createView,
  loadView,
  reorderViews,
  trashView,
  updateView,
} from "./views.js";

const suffix = randomBytes(6).toString("hex");

describe("the structure of a base, on the change trail", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let baseId = "";
  let tableId = "";

  /** The events of one catalog table, oldest first: what each kept. */
  async function eventsOf(table: string) {
    return db
      .selectFrom("auditEvents")
      .select(["userId", "tableId", "oldValue", "newValue", "source"])
      .where("action", "=", "catalog")
      .where("catalogTable", "=", table)
      .orderBy("occurredAt")
      .orderBy("id")
      .execute();
  }

  const named = (value: unknown) =>
    (value as { name?: string } | null)?.name ?? null;

  beforeAll(async () => {
    const created = await createTestDatabase("audit_structure");
    db = created.db;
    close = created.close;
    const person = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.org`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    owner = person.id;
    baseId = (await insertBase(db, owner, { name: "Structure" })).id;
    tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "Rows",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("keeps a base made, renamed, put in the trash, and restored", async () => {
    await updateBase(db, owner, { baseId, name: "Renamed" });
    await trashBase(db, owner, baseId);
    await restoreBase(db, owner, baseId);
    const events = await eventsOf("bases");
    expect(events.map((event) => event.userId)).toEqual(
      Array.from({ length: 4 }, () => owner),
    );
    expect(
      events.map((event) => [named(event.oldValue), named(event.newValue)]),
    ).toEqual([
      [null, "Structure"],
      ["Structure", "Renamed"],
      ["Renamed", "Renamed"],
      ["Renamed", "Renamed"],
    ]);
    // No table, and still a base: Administration's trail names it.
    const { events: listed } = await instanceAudit(db, {
      action: "catalog",
      limit: 50,
    });
    const renamed = listed.find(
      (event) =>
        event.catalogTable === "bases" && event.fields.includes("name"),
    );
    expect(renamed?.tableName).toBeNull();
    expect(renamed?.baseName).toBe("Renamed");
  });

  it("writes nothing, and fails nothing, when an update changes nothing", async () => {
    const before = (await eventsOf("bases")).length;
    // An update that set no field was a statement PostgreSQL refuses.
    await expect(updateBase(db, owner, { baseId })).resolves.toBeUndefined();
    await expect(updateTable(db, owner, { tableId })).resolves.toBeUndefined();
    expect((await eventsOf("bases")).length).toBe(before);
    // With something to change, it is written and kept.
    await updateBase(db, owner, { baseId, description: "Kept" });
    expect((await eventsOf("bases")).length).toBe(before + 1);
  });

  it("keeps a shared view's making, its lock, its trash and its return, under its table", async () => {
    const { engine } = await loadEngine(db, tableId, () => true);
    const before = (await eventsOf("views")).length;
    const view = await createView(db, engine, owner, {
      tableId,
      name: "Review",
      viewType: "grid",
      ownerId: null,
    });
    await updateView(db, engine, owner, await loadView(db, view.id), {
      locked: true,
    });
    await trashView(db, owner, await loadView(db, view.id));
    const trashed = await db
      .selectFrom("views")
      .selectAll()
      .where("id", "=", view.id)
      .executeTakeFirstOrThrow();
    await restoreView(db, owner, trashed);
    const events = (await eventsOf("views")).slice(before);
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.tableId === tableId)).toBe(true);
    expect(events.every((event) => event.userId === owner)).toBe(true);
    expect(events[1]?.newValue).toMatchObject({ locked: true });
  });

  it("keeps nothing of a person's own view, nor of the order of views", async () => {
    const { engine } = await loadEngine(db, tableId, () => true);
    const before = (await eventsOf("views")).length;
    const own = await createView(db, engine, owner, {
      tableId,
      name: "Mine",
      viewType: "grid",
      ownerId: owner,
    });
    await updateView(db, engine, owner, await loadView(db, own.id), {
      name: "Still mine",
    });
    const shared = await db
      .selectFrom("views")
      .select("id")
      .where("tableId", "=", tableId)
      .where("ownerId", "is", null)
      .where("deletedAt", "is", null)
      .orderBy("position")
      .execute();
    await reorderViews(
      db,
      owner,
      tableId,
      shared.map((view) => view.id).reverse(),
    );
    expect(await eventsOf("views")).toHaveLength(before);
  });

  it("keeps a dashboard, its widget, and a folder, not where a widget sits or a folder stands", async () => {
    const dashboard = await createDashboard(db, owner, {
      baseId,
      name: "Overview",
    });
    await updateDashboard(db, owner, {
      dashboardId: dashboard.id,
      name: "Figures",
    });
    const widget = await upsertWidget(db, owner, baseId, {
      dashboardId: dashboard.id,
      kind: "metric",
      title: "Rows",
      x: 0,
      y: 0,
      w: 3,
      h: 2,
      config: { tableId, column: "name", fn: "count_all" },
    });
    await layoutWidgets(db, owner, dashboard.id, [
      { id: widget.id, x: 3, y: 0, w: 3, h: 2 },
    ]);
    const first = await createFolder(db, owner, { baseId, name: "Archive" });
    const second = await createFolder(db, owner, { baseId, name: "Drafts" });
    await reorderFolders(db, owner, baseId, [second.id, first.id]);

    expect(
      (await eventsOf("dashboards")).map((event) => named(event.newValue)),
    ).toEqual(["Overview", "Figures"]);
    expect(await eventsOf("dashboard_widgets")).toHaveLength(1);
    expect(
      (await eventsOf("table_folders")).map((event) => named(event.newValue)),
    ).toEqual(["Archive", "Drafts"]);
  });
});
