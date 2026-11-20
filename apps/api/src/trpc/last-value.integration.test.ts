/**
 * A figure that reads the last value on a dashboard, against a real
 * database: the value a field holds in the row that comes last by another
 * field, the one made last among those that share it; rows without the
 * one or the other passed over; a view's filter and a reader's rules kept.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { setTableAcl } from "../data/acl.js";
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

describe("the last value on a dashboard", () => {
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
  let ownerId = "";
  let viewerId = "";
  let tableId = "";
  let emptyTableId = "";
  let dashboardId = "";

  /** A figure made of `config`, and what a reader of it is given. */
  const figure = async (
    config: Record<string, unknown>,
    reader = owner,
  ): Promise<Record<string, unknown>> => {
    const widget = await owner.call().dashboards.upsertWidget({
      dashboardId,
      title: "Balance",
      kind: "metric",
      config: { tableId, ...config },
    });
    return reader
      .call()
      .dashboards.widgetData({ dashboardId, widgetId: widget.id });
  };
  const last = (config: Record<string, unknown> = {}, reader = owner) =>
    figure(
      { column: "balance", fn: "last", orderBy: "day", ...config },
      reader,
    );

  beforeAll(async () => {
    const created = await createTestDatabase("last_value");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    ownerId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", `owner-${suffix}@example.org`)
        .executeTakeFirstOrThrow()
    ).id;
    viewerId = await signUpProved(viewer, db, {
      email: `viewer-${suffix}@example.org`,
      displayName: "Vera Viewer",
      password: PASSWORD,
    });
    const baseId = (await owner.call().catalog.createBase({ name: "Books" }))
      .id;
    await withAudit(db, { userId: ownerId, source: "web" }, (tx) =>
      bindRole(tx, viewerId, "viewer", baseId),
    );
    const newTable = async (name: string) =>
      (
        await owner.call().catalog.createTable({
          baseId,
          name,
          columns: [
            { name: "label", label: "Label", fieldType: "text" },
            { name: "day", label: "Day", fieldType: "date" },
            { name: "balance", label: "Balance", fieldType: "number" },
            { name: "account", label: "Account", fieldType: "text" },
          ],
        })
      ).id;
    tableId = await newTable("Movements");
    emptyTableId = await newTable("Closed");
    await owner.call().rows.insertMany({
      tableId,
      rows: [
        { label: "Opening", day: "2026-03-01", balance: "100", account: "a" },
        // Three movements the same day, in the order they were made.
        { label: "Rent", day: "2026-03-03", balance: "250.5", account: "a" },
        { label: "Card", day: "2026-03-03", balance: "240", account: "b" },
        { label: "Fee", day: "2026-03-03", balance: "199.99", account: "b" },
        { label: "Salary", day: "2026-03-02", balance: "120", account: "a" },
        // Neither says the last balance: no day, and a later day without
        // a balance.
        { label: "Undated", balance: "999", account: "a" },
        { label: "Pending", day: "2026-03-04", account: "a" },
      ],
    });
    dashboardId = (
      await owner.call().dashboards.create({ baseId, name: "Accounts" })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("reads the field in the last row by the other field, the one made last of a day", async () => {
    expect(await last()).toEqual({
      kind: "metric",
      fn: "last",
      column: "balance",
      // The third of March holds three rows: the last made is the fee.
      value: "199.99",
    });
    // Each field has its own last value: the row of the fourth has a
    // label and no balance. Whoever may read the table reads the figure.
    expect(await last({ column: "label" }, viewer)).toMatchObject({
      value: "Pending",
    });
    // The field that orders may be the one read: its greatest value.
    expect(await last({ orderBy: "balance" })).toMatchObject({ value: "999" });
  });

  it("keeps to the rows of the view it is given", async () => {
    const view = await owner.call().catalog.createView({
      tableId,
      name: "Account a",
      viewType: "grid",
      config: {
        filter: {
          conjunction: "and",
          conditions: [{ column: "account", op: "is", value: "a" }],
        },
      },
    });
    // Of account a, the third of March holds the rent alone.
    expect(await last({ viewId: view.id })).toMatchObject({ value: "250.5" });
  });

  it("is empty when no row holds both fields", async () => {
    expect(await last({ tableId: emptyTableId })).toMatchObject({
      value: null,
    });
  });

  it("reads as its reader may: their rows, and nothing of a field hidden from them", async () => {
    // Vera reads account a only.
    await setTableAcl(db, ownerId, {
      tableId,
      userId: viewerId,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "account", op: "is", value: "a" }],
      },
      columns: [],
    });
    expect(await last({}, viewer)).toMatchObject({ value: "250.5" });
    expect(await last()).toMatchObject({ value: "199.99" });
    // A field hidden from her reads as empty: so does the figure, as a
    // sum of it does.
    await setTableAcl(db, ownerId, {
      tableId,
      userId: viewerId,
      rowFilter: null,
      columns: [{ column: "balance", access: "hide" }],
    });
    expect(await last({}, viewer)).toMatchObject({ value: null });
    // Nor does a field hidden from her put her rows in order: which row
    // holds its greatest value would say something of it.
    await setTableAcl(db, ownerId, {
      tableId,
      userId: viewerId,
      rowFilter: null,
      columns: [{ column: "day", access: "hide" }],
    });
    expect(await last({}, viewer)).toMatchObject({ value: null });
    expect(await last()).toMatchObject({ value: "199.99" });
  });

  it("refuses a last value without its order, and an order on another measure", async () => {
    expect(await errorCode(figure({ column: "balance", fn: "last" }))).toBe(
      "BAD_REQUEST",
    );
    expect(
      await errorCode(figure({ column: "balance", fn: "sum", orderBy: "day" })),
    ).toBe("BAD_REQUEST");
    expect(await errorCode(last({ orderBy: "nothing" }))).toBe(
      "unknown_column",
    );
    // An aggregate is read as before.
    expect(await figure({ column: "balance", fn: "max" })).toEqual({
      kind: "metric",
      fn: "max",
      column: "balance",
      value: "999",
    });
  });
});
