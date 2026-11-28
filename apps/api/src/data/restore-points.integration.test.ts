/**
 * A base's restore points (ADR 0077), against a real database: made, kept
 * in the store, listed, read back into a new base, and removed with their
 * file when deleted, when past their date, or when their base goes.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { madeNames, MAX_RESTORE_POINTS } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiskStore } from "../files/index.js";
import { sweepOrphanFiles } from "../files/sweep.js";
import {
  addLocalGroupMember,
  createLocalGroup,
  deleteLocalGroup,
  listGroupRoles,
  setGroupRole,
} from "../scim/groups.js";
import { createTestDatabase } from "../test-database.js";
import { clearTableAcl, listTableAcls, setTableAcl } from "./acl.js";
import { narrowOn } from "./rules.test-helpers.js";
import { withAudit } from "./audit-context.js";
import {
  createDashboard,
  getDashboard,
  listDashboards,
  upsertWidget,
} from "./dashboards.js";
import { loadEngine } from "./engine.js";
import {
  deleteRestorePoint,
  listRestorePoints,
  makeRestorePoint,
  purgeRestorePoints,
  restoreFromPoint,
  restorePointKey,
} from "./restore-points.js";
import { insertRows, readPage } from "./rows.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { setTableRole } from "./sharing.js";
import { removeBase } from "./tables.js";

const suffix = randomBytes(6).toString("hex");

/** A file the store fails to delete fails the test. */
const failed = (error: unknown) => {
  throw error;
};

describe("restore points", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let files: DiskStore;
  let owner = "";
  let ada = "";
  let bob = "";
  let grace = "";
  let groupId = "";
  let baseId = "";
  const deps = () => ({ db, files, maxRows: 1_000_000 });

  beforeAll(async () => {
    const created = await createTestDatabase("restore_points");
    db = created.db;
    close = created.close;
    files = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-")));
    [owner, ada, bob, grace] = (
      await db
        .insertInto("users")
        .values([
          { email: `owner-${suffix}@example.com`, displayName: "Owner" },
          { email: `ada-${suffix}@example.com`, displayName: "Ada" },
          { email: `bob-${suffix}@example.com`, displayName: "Bob" },
          { email: `grace-${suffix}@example.com`, displayName: "Grace" },
        ])
        .returning("id")
        .execute()
    ).map((row) => row.id) as [string, string, string, string];
    baseId = (await insertBase(db, owner, { name: "Ventes" })).id;
    await withAudit(db, { userId: owner }, (tx) =>
      tx
        .insertInto("attributions")
        .values([
          { userId: ada, role: "editor", scope: "base", scopeId: baseId },
          { userId: bob, role: "editor", scope: "base", scopeId: baseId },
        ])
        .execute(),
    );
    // Grace reads the base through a group.
    groupId = (
      await createLocalGroup(db, owner, {
        displayName: `Sales ${suffix}`,
        description: null,
      })
    ).id;
    await addLocalGroupMember(db, owner, { groupId, userId: grace });
    await setGroupRole(db, owner, { baseId, groupId, role: "viewer" });
    const tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "Clients",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "margin", label: "Margin", fieldType: "number" },
          {
            name: "who",
            label: "Who",
            fieldType: "user",
            config: { multiple: true },
          },
        ],
      })
    ).id;
    // Ada edits the clients, but does not see their margin.
    await narrowOn(db, owner, {
      tableId,
      userId: ada,
      rowFilter: null,
      columns: [{ column: "margin", access: "hide" }],
    });
    const { engine, rows } = await loadEngine(db, tableId, () => true);
    const physical = rows.tables.find((item) => item.id === tableId);
    if (!physical) throw new Error("no table");
    await insertRows(
      db,
      engine,
      {
        userId: owner,
        tableId,
        physicalName: physical.physicalName,
        baseId,
        reason: null,
        source: "test",
      },
      [
        { name: "Acme", margin: 12, who: [grace] },
        { name: "Globex", margin: 30, who: [bob] },
        { name: "Initech" },
      ],
    );
    // The base has a dashboard, with one figure.
    const board = await createDashboard(db, owner, { baseId, name: "Marges" });
    await upsertWidget(db, owner, baseId, {
      dashboardId: board.id,
      title: "Marge totale",
      kind: "metric",
      x: 0,
      y: 0,
      w: 4,
      h: 3,
      config: { tableId, column: "margin", fn: "sum" },
    });
  });

  afterAll(async () => {
    await close?.();
  });

  it("keeps a point in the store and reads it back as a new base, with the access of those still in the base", async () => {
    const made = await makeRestorePoint(deps(), {
      userId: owner,
      baseId,
      note: "Before the import",
    });
    expect(made.rows).toBe(3);
    expect(await files.open(restorePointKey(made.id))).toBeDefined();
    const [listed] = await listRestorePoints(db, baseId);
    expect(listed).toMatchObject({
      id: made.id,
      rows: 3,
      note: "Before the import",
      createdBy: { id: owner, name: "Owner" },
    });
    const days =
      (Date.parse(listed?.expiresAt ?? "") -
        Date.parse(listed?.createdAt ?? "")) /
      (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(30);
    // On the trail, as the base's exports are.
    const trail = await db
      .selectFrom("auditEvents")
      .select("newValue")
      .where("action", "=", "export")
      .where("userId", "=", owner)
      .execute();
    expect(trail.map((event) => event.newValue)).toContainEqual({
      kind: "restore_point",
      format: "zip",
      rows: 3,
      baseId,
    });

    // Bob leaves the base after the point was made.
    await withAudit(db, { userId: owner }, (tx) =>
      tx
        .deleteFrom("attributions")
        .where("userId", "=", bob)
        .where("scopeId", "=", baseId)
        .execute(),
    );
    const restored = await restoreFromPoint(
      {
        db,
        files,
        maxRows: 1_000_000,
        maxFileBytes: 1_000_000,
        names: madeNames("fr"),
      },
      { userId: owner, restorePointId: made.id },
    );
    const base = await db
      .selectFrom("bases")
      .select("name")
      .where("id", "=", restored.baseId)
      .executeTakeFirstOrThrow();
    expect(base.name).toBe("Ventes (restaurée)");
    // Ada's rule took her role table by table (ADR 0131): she comes back
    // with the table, not as a member of the base.
    expect(restored.report).toMatchObject({ members: 0, membersLeft: 1 });
    const roles = await db
      .selectFrom("attributions")
      .select(["userId", "role"])
      .where("scope", "=", "base")
      .where("scopeId", "=", restored.baseId)
      .execute();
    // Grace reads it through her group's one attribution.
    expect(roles).toEqual(
      expect.arrayContaining([
        { userId: owner, role: "owner" },
        { userId: null, role: "viewer" },
      ]),
    );
    expect(roles.map((role) => role.userId)).not.toContain(bob);
    expect(await listGroupRoles(db, restored.baseId)).toMatchObject([
      { groupId, role: "viewer" },
    ]);
    const table = await db
      .selectFrom("dataTables")
      .select("id")
      .where("baseId", "=", restored.baseId)
      .executeTakeFirstOrThrow();
    // Ada still does not see the margin.
    expect(await listTableAcls(db, table.id)).toEqual([
      {
        userId: ada,
        rowFilter: null,
        columns: [{ column: "margin", access: "hide" }],
      },
    ]);
    const { engine } = await loadEngine(db, table.id, () => true);
    const page = await readPage(db, engine, { limit: 10 }, { total: true });
    expect(page.rows.map((row) => [row.name, row.margin, row.who])).toEqual([
      // Grace is in the base through her group: her cell stays.
      ["Acme", "12", [grace]],
      // Bob has left: he is left out of the cell, and the report says so.
      ["Globex", "30", null],
      ["Initech", null, null],
    ]);
    expect(restored.report.peopleDropped).toBe(1);
    // Its dashboard came back with it, reading the restored table.
    const [board] = await listDashboards(db, restored.baseId);
    expect(board?.name).toBe("Marges");
    const { widgets } = await getDashboard(db, board?.id ?? "");
    expect(widgets.map((widget) => [widget.title, widget.config])).toEqual([
      ["Marge totale", { tableId: table.id, column: "margin", fn: "sum" }],
    ]);
    expect(restored.report.widgetsLeft).toBe(0);
  });

  it("gives groups back their roles as the point kept them, on the base and on a table with its rule", async () => {
    const clients = await db
      .selectFrom("dataTables")
      .select("id")
      .where("baseId", "=", baseId)
      .executeTakeFirstOrThrow();
    // Payroll reads the clients table alone, its Acme row only; Temps
    // comments on the whole base.
    const payroll = (
      await createLocalGroup(db, owner, {
        displayName: `Payroll ${suffix}`,
        description: null,
      })
    ).id;
    const temps = (
      await createLocalGroup(db, owner, {
        displayName: `Temps ${suffix}`,
        description: null,
      })
    ).id;
    const acme = {
      conjunction: "and" as const,
      conditions: [{ column: "name", op: "is" as const, value: "Acme" }],
    };
    await setTableRole(
      db,
      owner,
      { id: clients.id, baseId },
      { groupId: payroll },
      "viewer",
    );
    await setTableAcl(db, owner, {
      tableId: clients.id,
      groupId: payroll,
      rowFilter: acme,
      columns: [],
    });
    await setGroupRole(db, owner, {
      baseId,
      groupId: temps,
      role: "commenter",
    });
    const made = await makeRestorePoint(deps(), { userId: owner, baseId });

    // Since the point: Sales leaves the base, Payroll's rule is cleared,
    // and Temps is deleted.
    await setGroupRole(db, owner, { baseId, groupId, role: null });
    await clearTableAcl(db, owner, clients.id, { groupId: payroll });
    await deleteLocalGroup(db, owner, temps);

    const restored = await restoreFromPoint(
      {
        db,
        files,
        maxRows: 1_000_000,
        maxFileBytes: 1_000_000,
        names: madeNames("fr"),
      },
      { userId: owner, restorePointId: made.id },
    );
    // As the point kept them: Sales on the base, Payroll on the table
    // with its rule; Temps is gone, and the report says so.
    expect(await listGroupRoles(db, restored.baseId)).toMatchObject([
      { groupId, role: "viewer" },
    ]);
    const table = await db
      .selectFrom("dataTables")
      .select("id")
      .where("baseId", "=", restored.baseId)
      .executeTakeFirstOrThrow();
    expect(await listTableAcls(db, table.id)).toContainEqual({
      groupId: payroll,
      rowFilter: acme,
      columns: [],
    });
    expect(restored.report.groupsLeft).toBe(1);
    // Only Sales holds the restored base: Temps came back nowhere.
    expect(
      await db
        .selectFrom("attributions")
        .select("groupId")
        .where("scope", "=", "base")
        .where("scopeId", "=", restored.baseId)
        .where("groupId", "is not", null)
        .execute(),
    ).toEqual([{ groupId }]);
  });

  it("refuses one more past the most a base keeps, and deletes one with its file", async () => {
    const kept = (await listRestorePoints(db, baseId)).length;
    const now = new Date();
    await db
      .insertInto("restorePoints")
      .values(
        Array.from({ length: MAX_RESTORE_POINTS - kept }, (_, index) => ({
          baseId,
          createdBy: owner,
          expiresAt: new Date(now.getTime() + 60_000),
          fileKey: `restore-points/00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          size: 0,
          rows: 0,
          files: 0,
        })),
      )
      .execute();
    await expect(
      makeRestorePoint(deps(), { userId: owner, baseId }),
    ).rejects.toThrow("Too many restore points");

    const real = (await listRestorePoints(db, baseId)).find(
      (point) => point.rows === 3,
    );
    if (!real) throw new Error("no real point");
    await deleteRestorePoint(db, files, real.id, failed);
    expect(await files.open(restorePointKey(real.id))).toBeUndefined();
    await expect(
      deleteRestorePoint(db, files, real.id, failed),
    ).rejects.toThrow("Unknown restore point");
  });

  it("keeps a point's file from the orphan sweep, and sweeps one no row names", async () => {
    const kept = await makeRestorePoint(deps(), { userId: owner, baseId });
    const lost = restorePointKey("00000000-0000-4000-8000-0000000000ff");
    await files.put(lost, Buffer.from("lost"), "application/zip");
    const orphans: string[] = [];
    await sweepOrphanFiles(
      { db, files },
      {
        before: new Date(Date.now() + 60_000),
        dryRun: true,
        onOrphan: (key) => orphans.push(key),
        onError: () => undefined,
      },
    );
    expect(orphans).toContain(lost);
    expect(orphans).not.toContain(restorePointKey(kept.id));
  });

  it("removes the points past their date, and a purged base's points with their files", async () => {
    await db
      .updateTable("restorePoints")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("baseId", "=", baseId)
      .execute();
    expect(await listRestorePoints(db, baseId)).toEqual([]);
    expect(await purgeRestorePoints(db, files, failed)).toBeGreaterThan(0);
    const left = await db
      .selectFrom("restorePoints")
      .select("id")
      .where("baseId", "=", baseId)
      .execute();
    expect(left).toEqual([]);

    const made = await makeRestorePoint(deps(), { userId: owner, baseId });
    await removeBase(db, files, owner, baseId, () => {});
    expect(await files.open(restorePointKey(made.id))).toBeUndefined();
    expect(
      await db
        .selectFrom("restorePoints")
        .select("id")
        .where("id", "=", made.id)
        .execute(),
    ).toEqual([]);
  });
});
