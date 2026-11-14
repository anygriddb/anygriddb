/**
 * Four gestures the API takes and no screen offers yet: the order of a
 * table's fields and of its views, a dashboard's name, and the place of
 * its widgets. Each against a real database: what it changes, what it
 * refuses, and who may ask.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { withAudit } from "../data/audit-context.js";
import { bindRole } from "../data/members.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  signUpProved,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("orders and places the API takes", () => {
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
  const viewer = browser();
  let baseId = "";
  let tableId = "";
  let otherTableId = "";

  const fieldNames = async () =>
    (
      await db
        .selectFrom("dataColumns")
        .select("name")
        .where("tableId", "=", tableId)
        .where("deletedAt", "is", null)
        .orderBy("position", "asc")
        .execute()
    ).map((column) => column.name);

  const viewNames = async () =>
    (
      await db
        .selectFrom("views")
        .select("name")
        .where("tableId", "=", tableId)
        .where("deletedAt", "is", null)
        .orderBy("position", "asc")
        .execute()
    ).map((view) => view.name);

  beforeAll(async () => {
    const created = await createTestDatabase("arranging");
    db = created.db;
    close = created.close;
    await owner.call().auth.signup({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    const ownerId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", `owner-${suffix}@example.org`)
        .executeTakeFirstOrThrow()
    ).id;
    const viewerId = await signUpProved(viewer, db, {
      email: `viewer-${suffix}@example.org`,
      displayName: "Vera Viewer",
      password: PASSWORD,
    });
    baseId = (await owner.call().catalog.createBase({ name: "Lab" })).id;
    await withAudit(db, { userId: ownerId, source: "web" }, (tx) =>
      bindRole(tx, viewerId, "viewer", baseId),
    );
    const newTable = async (name: string) =>
      (
        await owner.call().catalog.createTable({
          baseId,
          name,
          columns: [
            { name: "title", label: "Title", fieldType: "text" },
            { name: "amount", label: "Amount", fieldType: "number" },
          ],
        })
      ).id;
    tableId = await newTable("Orders");
    otherTableId = await newTable("Clients");
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("puts a table's fields in the order given, all of them or none", async () => {
    const before = await fieldNames();
    const reversed = [...before].reverse();
    await owner.call().catalog.reorderColumns({ tableId, order: reversed });
    expect(await fieldNames()).toEqual(reversed);

    // A field left out, or one the table does not have: nothing moves.
    expect(
      await errorCode(
        owner
          .call()
          .catalog.reorderColumns({ tableId, order: reversed.slice(1) }),
      ),
    ).toBe("invalid_order");
    expect(
      await errorCode(
        owner.call().catalog.reorderColumns({
          tableId,
          order: [...reversed.slice(1), "elsewhere"],
        }),
      ),
    ).toBe("invalid_order");
    expect(await fieldNames()).toEqual(reversed);

    expect(
      await errorCode(
        viewer.call().catalog.reorderColumns({ tableId, order: before }),
      ),
    ).toBe("access_denied");
    expect(await fieldNames()).toEqual(reversed);
  });

  it("puts a table's views in the order given, and takes no view of another table", async () => {
    const [first] = (await owner.call().catalog.views({ tableId })).views;
    const second = await owner.call().catalog.createView({
      tableId,
      name: "By amount",
      viewType: "grid",
    });
    const before = await viewNames();
    await owner.call().catalog.reorderViews({
      tableId,
      order: [second.id, first?.id ?? ""],
    });
    expect(await viewNames()).toEqual([...before].reverse());

    const [foreign] = (
      await owner.call().catalog.views({ tableId: otherTableId })
    ).views;
    expect(
      await errorCode(
        owner.call().catalog.reorderViews({
          tableId,
          order: [foreign?.id ?? "", second.id],
        }),
      ),
    ).toBe("invalid_order");
    expect(
      await errorCode(
        viewer.call().catalog.reorderViews({
          tableId,
          order: [first?.id ?? "", second.id],
        }),
      ),
    ).toBe("access_denied");
    expect(await viewNames()).toEqual([...before].reverse());
  });

  it("renames a dashboard and places its widgets, for who manages the base", async () => {
    const dashboard = await owner
      .call()
      .dashboards.create({ baseId, name: "Sales" });
    const widget = await owner.call().dashboards.upsertWidget({
      dashboardId: dashboard.id,
      title: "Orders",
      kind: "metric",
      config: { tableId, column: "amount", fn: "sum" },
    });
    const other = await owner
      .call()
      .dashboards.create({ baseId, name: "Stock" });
    const foreign = await owner.call().dashboards.upsertWidget({
      dashboardId: other.id,
      title: "Clients",
      kind: "metric",
      config: { tableId: otherTableId, column: "amount", fn: "sum" },
    });

    await owner.call().dashboards.update({
      dashboardId: dashboard.id,
      name: "Sales this year",
      description: "What was sold",
    });
    await owner.call().dashboards.layout({
      dashboardId: dashboard.id,
      widgets: [{ id: widget.id, x: 6, y: 2, w: 6, h: 4 }],
    });
    const read = await owner
      .call()
      .dashboards.get({ dashboardId: dashboard.id });
    expect(read).toMatchObject({
      dashboard: { name: "Sales this year", description: "What was sold" },
      widgets: [{ id: widget.id, x: 6, y: 2, w: 6, h: 4 }],
    });

    // A widget of another dashboard: the layout is applied whole, or not.
    expect(
      await errorCode(
        owner.call().dashboards.layout({
          dashboardId: dashboard.id,
          widgets: [
            { id: widget.id, x: 0, y: 0, w: 4, h: 3 },
            { id: foreign.id, x: 4, y: 0, w: 4, h: 3 },
          ],
        }),
      ),
    ).toBe("unknown_widget");
    expect(
      await errorCode(
        viewer
          .call()
          .dashboards.update({ dashboardId: dashboard.id, name: "Mine" }),
      ),
    ).toBe("access_denied");
    expect(
      await errorCode(
        viewer.call().dashboards.layout({
          dashboardId: dashboard.id,
          widgets: [{ id: widget.id, x: 0, y: 0, w: 4, h: 3 }],
        }),
      ),
    ).toBe("access_denied");
    expect(
      await owner.call().dashboards.get({ dashboardId: dashboard.id }),
    ).toMatchObject({
      dashboard: { name: "Sales this year" },
      widgets: [{ id: widget.id, x: 6, y: 2, w: 6, h: 4 }],
    });
  });
});
