/**
 * What a table's settings say of a field hidden from whoever reads them,
 * through the real router on a migrated database: a view, a widget, a
 * field's own settings, and a public link.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requestActor } from "../auth/access.js";
import { keyRing } from "../auth/key-ring.js";
import { createApiToken } from "../auth/tokens.js";
import { withAudit } from "../data/audit-context.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import type { Env } from "../env.js";
import { listTables } from "../public-api/operations.js";
import type { PublicApiDeps } from "../public-api/types.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, errorCode } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
/** What no reader under the rule may find in an answer. */
const FIELD = "salary";
const THRESHOLD = "91234";

describe("a field hidden from its reader", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: vi.fn(() => 0),
    closeAllBut: vi.fn(() => 0),
    closeSession: vi.fn(() => 0),
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const page = browser();
  let owner = "";
  let member = "";
  let ownerToken = "";
  let memberToken = "";
  let baseId = "";
  let tableId = "";
  let viewId = "";
  let dashboardId = "";

  const as = (token: string) => page.call({ authorization: `Bearer ${token}` });
  const viewOf = async (token: string, id = viewId) => {
    const { views } = await as(token).catalog.views({ tableId });
    const view = views.find((item) => item.id === id);
    if (!view) throw new Error("no view");
    return view;
  };
  const storedConfig = async (id = viewId) =>
    (
      await db
        .selectFrom("views")
        .select("config")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).config as Record<string, unknown>;

  const filter = {
    conjunction: "and" as const,
    conditions: [
      { column: "team", op: "is" as const, value: "North" },
      { column: FIELD, op: "gt" as const, value: Number(THRESHOLD) },
    ],
  };

  beforeAll(async () => {
    const created = await createTestDatabase("hidden_fields");
    db = created.db;
    close = created.close;
    [owner, member] = (
      await db
        .insertInto("users")
        .values([
          { email: `owner-${suffix}@example.org`, displayName: "Owner" },
          { email: `member-${suffix}@example.org`, displayName: "Member" },
        ])
        .returning("id")
        .execute()
    ).map((row) => row.id) as [string, string];
    await writeSettings(db, owner, { mfaScope: "admins" });
    baseId = (await insertBase(db, owner, { name: "Pay" })).id;
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({
          userId: member,
          role: "editor",
          scope: "base",
          scopeId: baseId,
        })
        .execute(),
    );
    tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "People",
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "team", label: "Team", fieldType: "text" },
          { name: FIELD, label: "Salary", fieldType: "number" },
        ],
      })
    ).id;
    ownerToken = (await createApiToken(db, owner, "owner", { days: 1 })).token;
    memberToken = (await createApiToken(db, member, "member", { days: 1 }))
      .token;
    const manager = as(ownerToken);
    await manager.catalog.addColumn({
      tableId,
      name: "band",
      label: "Band",
      fieldType: "formula",
      formulaSource: `IF({${FIELD}} > ${THRESHOLD}, "high", "low")`,
    });
    await manager.catalog.addColumn({
      tableId,
      name: "shout",
      label: "Shout",
      fieldType: "formula",
      formulaSource: "UPPER({title})",
    });
    viewId = (
      await manager.catalog.createView({
        tableId,
        name: "Well paid",
        viewType: "grid",
        config: {
          filter,
          sort: [{ column: FIELD, direction: "desc" }],
          fieldOrder: ["title", FIELD, "team"],
          hiddenFields: [FIELD],
          columnWidths: { [FIELD]: 111, title: 222 },
          aggregations: { [FIELD]: "sum" },
          color: {
            mode: "rules",
            rules: [
              {
                color: "red",
                filter: {
                  conjunction: "and",
                  conditions: [
                    {
                      column: FIELD,
                      op: "gt",
                      value: Number(THRESHOLD),
                    },
                  ],
                },
              },
            ],
          },
        },
      })
    ).id;
    await manager.catalog.setTableAcl({
      tableId,
      userId: member,
      rowFilter: null,
      columns: [
        { column: "title", access: "write" },
        { column: "team", access: "write" },
        { column: "band", access: "read" },
        { column: "shout", access: "read" },
        { column: FIELD, access: "hide" },
      ],
    });
    dashboardId = (await manager.dashboards.create({ baseId, name: "Numbers" }))
      .id;
    await manager.dashboards.upsertWidget({
      dashboardId,
      kind: "metric",
      title: "Payroll",
      config: { tableId, column: FIELD, fn: "sum" },
    });
    await manager.dashboards.upsertWidget({
      dashboardId,
      kind: "chart",
      title: "By team",
      config: {
        tableId,
        groupBy: "team",
        seriesBy: FIELD,
        chartType: "bar",
        column: FIELD,
        fn: "sum",
      },
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("leaves the field out of the views its reader lists", async () => {
    const view = await viewOf(memberToken);
    const text = JSON.stringify(view);
    expect(text).not.toContain(FIELD);
    expect(text).not.toContain(THRESHOLD);
    expect(view.config.filter?.conditions).toEqual([
      { column: "team", op: "is", value: "North" },
    ]);
  });

  it("shows the table's owner the whole view", async () => {
    const view = await viewOf(ownerToken);
    expect(JSON.stringify(view)).toContain(FIELD);
    expect(JSON.stringify(view)).toContain(THRESHOLD);
  });

  it("keeps what an editor cannot see when they save the view", async () => {
    const before = await storedConfig();
    const saved = await as(memberToken).catalog.updateView({
      viewId,
      patch: { rowHeight: "tall" },
    });
    expect(JSON.stringify(saved)).not.toContain(FIELD);
    const after = await storedConfig();
    expect(after).toEqual({ ...before, rowHeight: "tall" });
  });

  it("keeps the hidden parts when an editor saves all they saw", async () => {
    const before = await storedConfig();
    const { config } = await viewOf(memberToken);
    await as(memberToken).catalog.updateView({ viewId, config });
    expect(await storedConfig()).toEqual(before);
  });

  it("keeps a hidden condition when an editor changes the filter", async () => {
    await as(memberToken).catalog.updateView({
      viewId,
      patch: {
        filter: {
          conjunction: "and",
          conditions: [{ column: "team", op: "is", value: "South" }],
        },
      },
    });
    const stored = (await storedConfig()).filter as typeof filter;
    expect(stored.conditions).toContainEqual({
      column: "team",
      op: "is",
      value: "South",
    });
    expect(stored.conditions).toContainEqual(filter.conditions[1]);
    await as(ownerToken).catalog.updateView({ viewId, patch: { filter } });
  });

  it("takes nothing an editor writes about a field hidden from them", async () => {
    const made = await as(memberToken).catalog.createView({
      tableId,
      name: "Guess",
      viewType: "grid",
      config: {
        filter: {
          conjunction: "and",
          conditions: [{ column: FIELD, op: "gt", value: 1 }],
        },
        sort: [{ column: FIELD, direction: "asc" }],
      },
    });
    expect(JSON.stringify(await storedConfig(made.id))).not.toContain(FIELD);
    await as(memberToken).catalog.updateView({
      viewId: made.id,
      config: { sort: [{ column: FIELD, direction: "desc" }] },
    });
    expect(JSON.stringify(await storedConfig(made.id))).not.toContain(FIELD);
    await as(memberToken).catalog.deleteView({ viewId: made.id });
  });

  it("gives a copy of a view its hidden parts, and not to read", async () => {
    const copy = await as(memberToken).catalog.duplicateView({
      viewId,
      name: "Copy",
    });
    expect(JSON.stringify(copy)).not.toContain(FIELD);
    expect(JSON.stringify(await storedConfig(copy.id))).toContain(FIELD);
    await as(memberToken).catalog.deleteView({ viewId: copy.id });
  });

  it("leaves the field out of a dashboard's widgets", async () => {
    const seen = await as(memberToken).dashboards.get({ dashboardId });
    expect(JSON.stringify(seen.widgets)).not.toContain(FIELD);
    const full = await as(ownerToken).dashboards.get({ dashboardId });
    expect(JSON.stringify(full.widgets)).toContain(FIELD);
    const metric = seen.widgets.find((widget) => widget.kind === "metric");
    const data = await as(memberToken).dashboards.widgetData({
      dashboardId,
      widgetId: metric?.id ?? "",
    });
    expect(JSON.stringify(data)).not.toContain(FIELD);
    const chart = seen.widgets.find((widget) => widget.kind === "chart");
    const drawn = await as(memberToken).dashboards.widgetData({
      dashboardId,
      widgetId: chart?.id ?? "",
    });
    expect(JSON.stringify(drawn)).not.toContain(FIELD);
  });

  it("takes the formula out of a field that reads the hidden one", async () => {
    const deps = {
      db,
      bus: recordingBus().bus,
      publicUrl: env.PUBLIC_URL,
    } as unknown as PublicApiDeps;
    const reader = await requestActor(
      db,
      { authorization: `Bearer ${memberToken}` },
      undefined,
    );
    if (!reader) throw new Error("no reader");
    const { tables } = await listTables(deps, reader, baseId);
    const fields = tables.find((table) => table.id === tableId)?.fields ?? [];
    expect(JSON.stringify(fields)).not.toContain(FIELD);
    expect(JSON.stringify(fields)).not.toContain(THRESHOLD);
    // One on fields the reader sees stays readable.
    const shout = fields.find((field) => field.name === "shout");
    expect(JSON.stringify(shout?.config)).toContain("title");

    const manager = await requestActor(
      db,
      { authorization: `Bearer ${ownerToken}` },
      undefined,
    );
    if (!manager) throw new Error("no manager");
    const all = await listTables(deps, manager, baseId);
    expect(JSON.stringify(all.tables)).toContain(THRESHOLD);
  });

  it("does the same in the catalog a member's pages read", async () => {
    const bases = await as(memberToken).catalog.list();
    const text = JSON.stringify(bases);
    expect(text).not.toContain(THRESHOLD);
    expect(text).not.toContain(`{${FIELD}}`);
  });

  it("gives a public link what it draws and nothing else", async () => {
    const shared = await as(ownerToken).catalog.createView({
      tableId,
      name: "Public",
      viewType: "grid",
      config: { hiddenFields: [FIELD] },
    });
    const { token } = await as(ownerToken).catalog.createShare({
      viewId: shared.id,
    });
    const opened = await page.call().share.open({ token });
    const text = JSON.stringify(opened);
    expect(opened.columns.map((column) => column.name)).toContain("band");
    expect(text).not.toContain(FIELD);
    expect(text).not.toContain(THRESHOLD);
    for (const column of opened.columns) {
      expect(column.config).not.toHaveProperty("expr");
      expect(column.formula).toBeNull();
      expect(column.formulaSource).toBeNull();
      expect(column.computed).toBeNull();
    }
  });

  it("gives a link to the base no more than a link to a view", async () => {
    const { token } = await as(ownerToken).catalog.createBaseShare({ baseId });
    const opened = await page.call().share.openBase({ token });
    const table = opened.tables.find((item) => item.id === tableId);
    expect(table?.columns.map((column) => column.name)).toContain("band");
    expect(JSON.stringify(table)).not.toContain(THRESHOLD);
    for (const column of table?.columns ?? []) {
      expect(column.config).not.toHaveProperty("expr");
      expect(column.computed).toBeNull();
    }
  });

  it("says a base in the trash is not found, and an empty one is empty", async () => {
    const deps = {
      db,
      bus: recordingBus().bus,
      publicUrl: env.PUBLIC_URL,
    } as unknown as PublicApiDeps;
    const manager = await requestActor(
      db,
      { authorization: `Bearer ${ownerToken}` },
      undefined,
    );
    if (!manager) throw new Error("no manager");
    const empty = (await as(ownerToken).catalog.createBase({ name: "Empty" }))
      .id;
    const fresh = await requestActor(
      db,
      { authorization: `Bearer ${ownerToken}` },
      undefined,
    );
    expect(await listTables(deps, fresh as never, empty)).toEqual({
      tables: [],
    });
    await as(ownerToken).catalog.deleteBase({ baseId: empty });
    expect(await errorCode(listTables(deps, fresh as never, empty))).toBe(
      "not_found",
    );
  });
});
