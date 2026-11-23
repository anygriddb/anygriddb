/**
 * Putting an earlier value back (ADR 0089): a new write, from the trail,
 * refused when the screen is stale, when a row is locked, when a field
 * is hidden, and when a field's type has changed.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  joinBase,
  signUpProved,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("putting a value back", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const owner = browser();
  const editor = browser();
  let baseId = "";
  let tableId = "";
  let rowId = "";
  let editorId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("revert");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    baseId = (await owner.call().catalog.createBase({ name: "Ledger" })).id;
    tableId = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Samples",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    rowId = (
      await owner.call().rows.insert({
        tableId,
        values: { title: "start" },
      })
    ).id;
    for (const title of ["one", "two", "three"]) {
      await owner.call().rows.updateMany({
        tableId,
        updates: [{ rowId, values: { title } }],
      });
    }
    editorId = await signUpProved(editor, db, {
      email: `editor-${suffix}@example.org`,
      displayName: "Ed Editor",
      password: PASSWORD,
    });
    await joinBase(db, { baseId, userId: editorId, role: "editor" });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  async function row() {
    const page = await owner.call().rows.read({ tableId, limit: 10 });
    const found = page.rows.find((item) => item.id === rowId);
    if (!found) throw new Error("row missing");
    return found;
  }

  it("puts a field back to the value before the latest edit", async () => {
    const history = await owner.call().rows.audit({ tableId, recordId: rowId });
    const event = history.events.find((item) => {
      const old = item.oldValue as { title?: string } | null;
      return item.action === "update" && old?.title === "two";
    });
    expect(event?.id).toEqual(expect.any(String));
    await owner.call().rows.revert({
      tableId,
      recordId: rowId,
      eventId: event?.id ?? "",
      field: "title",
      seen: await row(),
    });
    expect((await row()).title).toBe("two");
    const again = await owner.call().rows.audit({ tableId, recordId: rowId });
    expect(again.events[0]?.source).toBe("revert");
  });

  it("refuses when the value on screen is no longer the one stored", async () => {
    const history = await owner.call().rows.audit({ tableId, recordId: rowId });
    const event = history.events.find((item) => item.action === "update");
    const current = await row();
    expect(
      await errorCode(
        owner.call().rows.revert({
          tableId,
          recordId: rowId,
          eventId: event?.id ?? "",
          field: "title",
          seen: { ...current, title: "not what is stored" },
        }),
      ),
    ).toBe("revert_stale");
  });

  it("refuses a hidden field and a locked row", async () => {
    const added = await owner.call().catalog.addColumn({
      tableId,
      label: "Secret",
      fieldType: "text",
    });
    await owner.call().rows.updateMany({
      tableId,
      updates: [{ rowId, values: { [added.name]: "hidden" } }],
    });
    await owner.call().catalog.setTableAcl({
      tableId,
      userId: editorId,
      rowFilter: null,
      columns: [{ column: "title", access: "write" }],
    });
    const history = await owner.call().rows.audit({ tableId, recordId: rowId });
    const event = history.events.find((item) => {
      const next = item.newValue as Record<string, unknown> | null;
      return next?.[added.name] === "hidden";
    });
    expect(
      await errorCode(
        editor.call().rows.revert({
          tableId,
          recordId: rowId,
          eventId: event?.id ?? "",
          field: added.name,
          seen: await row(),
        }),
      ),
    ).toBe("access_denied");

    // An ordinary write's `expected` is not read on AnyGridDB's own
    // tables: compared with a field the editor cannot see, the answer
    // would tell whether a guess at it is right.
    for (const guess of ["hidden", "a wrong guess"]) {
      await editor.call().rows.updateMany({
        tableId,
        updates: [
          {
            rowId,
            values: { title: `after ${guess}` },
            expected: { [added.name]: guess },
          },
        ],
      });
    }
    expect((await row()).title).toBe("after a wrong guess");

    await owner.call().rows.setStatus({
      tableId,
      rowId,
      status: "submitted",
    });
    await owner.call().rows.setStatus({ tableId, rowId, status: "locked" });
    const open = history.events.find((item) => item.action === "update");
    expect(
      await errorCode(
        owner.call().rows.revert({
          tableId,
          recordId: rowId,
          eventId: open?.id ?? "",
          field: "title",
          seen: await row(),
        }),
      ),
    ).toBe("row_locked");
    await owner.call().rows.setStatus({ tableId, rowId, status: "draft" });
  });

  it("puts a base, a table, a field, a view, and a folder back", async () => {
    await owner.call().catalog.updateBase({ baseId, name: "Ledger 2" });
    await owner.call().catalog.updateBase({ baseId, name: "Ledger 3" });
    const bases = await owner
      .call()
      .catalog.earlier({ kind: "base", id: baseId });
    const renamed = bases.events.find((event) =>
      event.changes.some(
        (change) => change.field === "name" && change.before === "Ledger 2",
      ),
    );
    await owner.call().catalog.revert({
      kind: "base",
      id: baseId,
      eventId: renamed?.id ?? "",
      field: "name",
      seen: { name: "Ledger 3" },
    });
    const base = await db
      .selectFrom("bases")
      .select("name")
      .where("id", "=", baseId)
      .executeTakeFirstOrThrow();
    expect(base.name).toBe("Ledger 2");
    expect(
      await errorCode(
        owner.call().catalog.revert({
          kind: "base",
          id: baseId,
          eventId: renamed?.id ?? "",
          field: "name",
          seen: { name: "Ledger" },
        }),
      ),
    ).toBe("revert_stale");

    await owner.call().catalog.updateTable({ tableId, name: "Samples 2" });
    const tables = await owner
      .call()
      .catalog.earlier({ kind: "table", id: tableId });
    const tableEvent = tables.events.find((event) =>
      event.changes.some((change) => change.before === "Samples"),
    );
    await owner.call().catalog.revert({
      kind: "table",
      id: tableId,
      eventId: tableEvent?.id ?? "",
      field: "name",
      seen: { name: "Samples 2" },
    });

    await owner.call().catalog.updateColumn({
      tableId,
      name: "title",
      label: "Heading",
    });
    const column = await db
      .selectFrom("dataColumns")
      .select("id")
      .where("tableId", "=", tableId)
      .where("name", "=", "title")
      .executeTakeFirstOrThrow();
    const fields = await owner
      .call()
      .catalog.earlier({ kind: "column", id: column.id });
    const label = fields.events.find((event) =>
      event.changes.some((change) => change.field === "label"),
    );
    await owner.call().catalog.revert({
      kind: "column",
      id: column.id,
      eventId: label?.id ?? "",
      field: "label",
      seen: { label: "Heading" },
    });
    await owner.call().catalog.updateColumn({
      tableId,
      name: "title",
      fieldType: "single_select",
    });
    const converted = await owner
      .call()
      .catalog.earlier({ kind: "column", id: column.id });
    expect(converted.events[0]?.canRevertAll).toBe(false);
    expect(
      await errorCode(
        owner.call().catalog.revert({
          kind: "column",
          id: column.id,
          eventId: converted.events[0]?.id ?? "",
          seen: { label: "Title" },
        }),
      ),
    ).toBe("revert_unavailable");

    const views = await owner.call().catalog.views({ tableId });
    const view = views.views[0];
    if (!view) throw new Error("view missing");
    await owner.call().catalog.updateView({ viewId: view.id, name: "Grid 2" });
    const listed = await owner
      .call()
      .catalog.earlier({ kind: "view", id: view.id });
    const viewEvent = listed.events.find((event) => event.canRevertAll);
    await owner.call().catalog.revert({
      kind: "view",
      id: view.id,
      eventId: viewEvent?.id ?? "",
      seen: { name: "Grid 2", config: view.config },
    });

    const folder = await owner
      .call()
      .catalog.createFolder({ baseId, name: "Archive" });
    await owner
      .call()
      .catalog.updateFolder({ folderId: folder.id, name: "Archive 2" });
    const folders = await owner
      .call()
      .catalog.earlier({ kind: "folder", id: folder.id });
    const folderEvent = folders.events.find((event) =>
      event.changes.some((change) => change.before === "Archive"),
    );
    await owner.call().catalog.revert({
      kind: "folder",
      id: folder.id,
      eventId: folderEvent?.id ?? "",
      field: "name",
      seen: { name: "Archive 2" },
    });
  });

  it("puts a dashboard, a widget, an automation, and a webhook back", async () => {
    const dashboard = await owner
      .call()
      .dashboards.create({ baseId, name: "Board" });
    await owner
      .call()
      .dashboards.update({ dashboardId: dashboard.id, name: "Board 2" });
    const boards = await owner
      .call()
      .catalog.earlier({ kind: "dashboard", id: dashboard.id });
    const boardEvent = boards.events.find((event) =>
      event.changes.some((change) => change.before === "Board"),
    );
    await owner.call().catalog.revert({
      kind: "dashboard",
      id: dashboard.id,
      eventId: boardEvent?.id ?? "",
      field: "name",
      seen: { name: "Board 2" },
    });

    const widget = await owner.call().dashboards.upsertWidget({
      dashboardId: dashboard.id,
      title: "Orders",
      kind: "metric",
      config: { tableId, column: "notes", fn: "count_filled" },
    });
    await owner.call().dashboards.upsertWidget({
      dashboardId: dashboard.id,
      widgetId: widget.id,
      title: "Orders 2",
      kind: "metric",
      config: { tableId, column: "notes", fn: "count_filled" },
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
    });
    const widgets = await owner
      .call()
      .catalog.earlier({ kind: "widget", id: widget.id });
    const widgetEvent = widgets.events.find((event) =>
      event.changes.some((change) => change.field === "title"),
    );
    await owner.call().catalog.revert({
      kind: "widget",
      id: widget.id,
      eventId: widgetEvent?.id ?? "",
      field: "title",
      seen: {
        title: "Orders 2",
        kind: "metric",
        config: { tableId, column: "notes", fn: "count_filled" },
      },
    });
    const kept = await db
      .selectFrom("dashboardWidgets")
      .select(["title", "x"])
      .where("id", "=", widget.id)
      .executeTakeFirstOrThrow();
    expect(kept.title).toBe("Orders");
    expect(kept.x).toBe(widget.x);

    const automation = await owner.call().automations.create({
      tableId,
      name: "Notice",
      trigger: { type: "row_created" },
      actions: [{ type: "update_record", values: { title: "one" } }],
    });
    await owner.call().automations.update({
      automationId: automation.id,
      name: "Notice 2",
      trigger: { type: "row_created" },
      actions: [{ type: "update_record", values: { title: "one" } }],
    });
    const automations = await owner
      .call()
      .catalog.earlier({ kind: "automation", id: automation.id });
    const automationEvent = automations.events.find((event) =>
      event.changes.some((change) => change.field === "name"),
    );
    await owner.call().catalog.revert({
      kind: "automation",
      id: automation.id,
      eventId: automationEvent?.id ?? "",
      field: "name",
      seen: {
        name: "Notice 2",
        enabled: true,
        trigger: { type: "row_created" },
        actions: [{ type: "update_record", values: { title: "one" } }],
      },
    });

    const hook = await owner.call().catalog.createWebhook({
      tableId,
      kind: "http",
      target: "https://1.1.1.1/hook",
      events: ["update"],
      name: "Outbound",
    });
    await owner.call().catalog.updateWebhook({
      webhookId: hook.id,
      name: "Outbound 2",
    });
    const hooks = await owner
      .call()
      .catalog.earlier({ kind: "webhook", id: hook.id });
    expect(
      hooks.events.every((event) =>
        event.changes.every((change) => !change.field.includes("secret")),
      ),
    ).toBe(true);
    const hookEvent = hooks.events.find((event) =>
      event.changes.some((change) => change.before === "Outbound"),
    );
    await owner.call().catalog.revert({
      kind: "webhook",
      id: hook.id,
      eventId: hookEvent?.id ?? "",
      field: "name",
      seen: { name: "Outbound 2" },
    });

    const role = await db
      .selectFrom("auditEvents")
      .select("id")
      .where("catalogTable", "=", "role_bindings")
      .orderBy("occurredAt", "desc")
      .executeTakeFirstOrThrow();
    expect(
      await errorCode(
        owner.call().catalog.revert({
          kind: "base",
          id: baseId,
          eventId: role.id,
          seen: { name: "Ledger 2" },
        }),
      ),
    ).toBe("revert_unavailable");
  });
});
