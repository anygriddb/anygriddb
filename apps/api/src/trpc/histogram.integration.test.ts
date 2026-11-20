/**
 * A histogram on a dashboard, against a real database: the rows of a
 * table counted in equal bins of a number field, between its least and
 * its greatest value; a view's filter keeps to its rows; one bin when
 * every value is the same, none without a value; and a chart that is no
 * histogram keeps its groups.
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

describe("a histogram on a dashboard", () => {
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
  let emptyTableId = "";
  let dashboardId = "";

  /** A widget made of `config`, and what a reader of it is given. */
  const chart = async (
    config: Record<string, unknown>,
    reader = owner,
  ): Promise<Record<string, unknown>> => {
    const widget = await owner.call().dashboards.upsertWidget({
      dashboardId,
      title: "Amounts",
      kind: "chart",
      config: { tableId, ...config },
    });
    return reader
      .call()
      .dashboards.widgetData({ dashboardId, widgetId: widget.id });
  };

  beforeAll(async () => {
    const created = await createTestDatabase("histogram");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
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
    baseId = (await owner.call().catalog.createBase({ name: "Shop" })).id;
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
            { name: "flat", label: "Flat", fieldType: "number" },
          ],
        })
      ).id;
    tableId = await newTable("Orders");
    emptyTableId = await newTable("Returns");
    await owner.call().rows.insertMany({
      tableId,
      rows: [
        // Ten values from 0 to 100, one on a line between two bins, two
        // on the last line, and a row without a value.
        ...[0, 5, 24.99, 25, 40, 60, 74, 90, 100, 100].map((amount, index) => ({
          title: `Order ${String(index)}`,
          amount: String(amount),
          flat: "7",
        })),
        { title: "No amount" },
      ],
    });
    dashboardId = (
      await owner.call().dashboards.create({ baseId, name: "Sales" })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("counts the rows in equal bins, between the least and the greatest value", async () => {
    const read = await chart({
      chartType: "histogram",
      column: "amount",
      bins: 4,
    });
    expect(read).toEqual({
      kind: "chart",
      chartType: "histogram",
      fn: "count_all",
      keyTypes: { category: "number", series: null },
      bounds: { lo: 0, hi: 100 },
      // Bins stand each on its own: a histogram has no series.
      sideBySide: false,
      // Nor dates to group.
      period: null,
      // A bin's place; the page names it by its bounds.
      categories: ["0", "1", "2", "3"],
      // 25 is in the second bin, both 100 in the last; the row without
      // a value is in none.
      series: [{ name: "", values: [3, 2, 2, 3] }],
      omitted: { categories: 0, series: 0 },
    });
    // Twelve bins when it does not say how many, and forty at most.
    const twelve = await chart({ chartType: "histogram", column: "amount" });
    expect(twelve.categories).toHaveLength(12);
    expect(
      (twelve.series as Array<{ values: number[] }>)[0]?.values.reduce(
        (sum, count) => sum + count,
        0,
      ),
    ).toBe(10);
    // Whoever may read the table reads the chart.
    const seen = await chart(
      { chartType: "histogram", column: "amount", bins: 4 },
      viewer,
    );
    expect(seen.series).toEqual([{ name: "", values: [3, 2, 2, 3] }]);
  });

  it("keeps to the rows of the view it is given", async () => {
    const view = await owner.call().catalog.createView({
      tableId,
      name: "Large",
      viewType: "grid",
      config: {
        filter: {
          conjunction: "and",
          conditions: [{ column: "amount", op: "gte", value: 60 }],
        },
      },
    });
    const read = await chart({
      chartType: "histogram",
      column: "amount",
      bins: 2,
      viewId: view.id,
    });
    // 60, 74, 90, 100, 100: the bounds are those of the view's rows.
    expect(read).toMatchObject({
      bounds: { lo: 60, hi: 100 },
      series: [{ name: "", values: [2, 3] }],
    });
  });

  it("is one bin when every value is the same, and none without a value", async () => {
    expect(
      await chart({ chartType: "histogram", column: "flat", bins: 8 }),
    ).toMatchObject({
      bounds: { lo: 7, hi: 7 },
      categories: ["0"],
      series: [{ name: "", values: [10] }],
    });
    expect(
      await chart({
        tableId: emptyTableId,
        chartType: "histogram",
        column: "amount",
      }),
    ).toMatchObject({
      bounds: null,
      categories: [],
      series: [{ name: "", values: [] }],
    });
  });

  it("refuses a histogram with groups, of a text, or of too many bins", async () => {
    const refused = (config: Record<string, unknown>) =>
      errorCode(chart({ chartType: "histogram", ...config }));
    expect(await refused({})).toBe("BAD_REQUEST");
    expect(await refused({ column: "amount", groupBy: "title" })).toBe(
      "BAD_REQUEST",
    );
    expect(await refused({ column: "amount", seriesBy: "title" })).toBe(
      "BAD_REQUEST",
    );
    expect(await refused({ column: "amount", fn: "sum" })).toBe("BAD_REQUEST");
    expect(await refused({ column: "amount", bins: 41 })).toBe("BAD_REQUEST");
    expect(await refused({ column: "amount", bins: 1 })).toBe("BAD_REQUEST");
    // A text has no least and greatest number to share in bins.
    expect(await refused({ column: "title" })).toBe("invalid_aggregate");
  });

  it("leaves a chart that is no histogram its groups, and asks for them", async () => {
    const read = await chart({ chartType: "bar", groupBy: "flat" });
    expect(read).toMatchObject({
      chartType: "bar",
      bounds: null,
      categories: ["(vide)", "7"],
      series: [{ name: "", values: [1, 10] }],
    });
    expect(await errorCode(chart({ chartType: "bar" }))).toBe("BAD_REQUEST");
    expect(
      await errorCode(chart({ chartType: "bar", groupBy: "flat", bins: 4 })),
    ).toBe("BAD_REQUEST");
  });
});
