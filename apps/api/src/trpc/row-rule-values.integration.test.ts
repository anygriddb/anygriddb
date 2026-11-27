/**
 * A row rule whose condition holds no value its field takes, through the
 * real router on a migrated database: refused when a manager sets it, and
 * showing no row when one kept before is read. A filter sent to the public
 * API with such a value is refused, where it used to be left out.
 */
import { randomBytes } from "node:crypto";
import type { FilterGroup } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import { createApiToken } from "../auth/tokens.js";
import { withAudit } from "../data/audit-context.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { listRecords } from "../public-api/operations.js";
import type { Actor, PublicApiDeps } from "../public-api/types.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { errorCode, plainBrowsers } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

type Condition = { column: string; op: string; value?: unknown };
const rule = (...conditions: Condition[]) =>
  ({ conjunction: "and", conditions }) as never;
const NORTH: Condition = { column: "region", op: "is", value: "north" };

describe("a row rule whose condition holds no value its field takes", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const page = plainBrowsers(() => db)();
  let owner = "";
  let member = "";
  let ownerToken = "";
  let memberToken = "";
  let tableId = "";

  const as = (token: string) => page.call({ authorization: `Bearer ${token}` });
  const setRule = (rowFilter: FilterGroup) =>
    as(ownerToken).catalog.setTableAcl({
      tableId,
      userId: member,
      columns: [],
      rowFilter,
    });
  const regionsRead = async () =>
    (await as(memberToken).rows.read({ tableId, limit: 100 })).rows
      .map((row) => String(row.region))
      .sort();
  const previewed = async () =>
    (
      await as(ownerToken).catalog.viewAs({
        tableId,
        userId: member,
        limit: 10,
      })
    ).sample.rows.length;

  beforeAll(async () => {
    const created = await createTestDatabase("row_rule_values");
    db = created.db;
    close = created.close;
    const account = async (name: string) =>
      (
        await db
          .insertInto("users")
          .values({ email: `${name}-${suffix}@example.org`, displayName: name })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    owner = await account("owner");
    member = await account("member");
    await writeSettings(db, owner, { mfaScope: "admins" });
    const fields = {
      region: "text",
      amount: "number",
      paid: "boolean",
      day: "date",
    } as const;
    tableId = (
      await insertTable(db, owner, {
        baseId: (await insertBase(db, owner, { name: "Sales" })).id,
        name: "Orders",
        columns: Object.entries(fields).map(([name, fieldType]) => ({
          name,
          label: name,
          fieldType,
        })),
      })
    ).id;
    // A role on the table alone, which a rule narrows (ADR 0131).
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("attributions")
        .values({
          userId: member,
          role: "viewer",
          scope: "table",
          scopeId: tableId,
        })
        .execute(),
    );
    ownerToken = (await createApiToken(db, owner, "owner", { days: 1 })).token;
    memberToken = (await createApiToken(db, member, "member", { days: 1 }))
      .token;
    await as(ownerToken).rows.insertMany({
      tableId,
      rows: [
        { region: "north", amount: 10, paid: true, day: "2026-01-01" },
        { region: "north", amount: 20, paid: false, day: "2026-01-02" },
        { region: "south", amount: 30, paid: true, day: "2026-01-03" },
        { region: "south", amount: 40, paid: false, day: "2026-01-04" },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("keeps a rule whose every condition holds its value", async () => {
    expect(await errorCode(setRule(rule(NORTH)))).toBe("ok");
    expect(await regionsRead()).toEqual(["north", "north"]);
    expect(await previewed()).toBe(2);
  });

  it.each([
    ["a blank text", { column: "region", op: "is", value: "" }],
    ["no value at all", { column: "region", op: "is" }],
    ["a word for a number", { column: "amount", op: "is", value: "abc" }],
    ["a word to compare", { column: "amount", op: "gt", value: "ten" }],
    ["a text for a checkbox", { column: "paid", op: "is", value: "true" }],
    ["a word for a day", { column: "day", op: "is", value: "not a date" }],
  ] as const)(
    "refuses a rule with %s, and keeps the rule before",
    async (_, bad) => {
      expect(await errorCode(setRule(rule(bad)))).toBe("invalid_filter");
      // Beside a good condition, the bad one would only have weakened it.
      expect(await errorCode(setRule(rule(NORTH, bad)))).toBe("invalid_filter");
      expect(await errorCode(setRule(rule()))).toBe("invalid_filter");
      expect(await regionsRead()).toEqual(["north", "north"]);
    },
  );

  it("shows no row under a rule kept before such a rule was refused", async () => {
    for (const kept of [
      rule({ column: "region", op: "is", value: "" }),
      rule(NORTH, { column: "amount", op: "is", value: "abc" }),
      rule(),
    ]) {
      await withAudit(db, { userId: owner, source: "web" }, (tx) =>
        tx
          .updateTable("attributions")
          .set({ rowFilter: kept })
          .where("userId", "=", member)
          .where("scopeId", "=", tableId)
          .execute(),
      );
      expect(await regionsRead()).toEqual([]);
      expect(await previewed()).toBe(0);
    }
    expect(await errorCode(setRule(rule(NORTH)))).toBe("ok");
    expect(await regionsRead()).toEqual(["north", "north"]);
  });

  it("refuses from the public API a value the field cannot hold, and leaves out a blank one", async () => {
    const deps: PublicApiDeps = {
      db,
      bus: { publish: () => Promise.resolve() } as never,
      publicUrl: "https://grid.example.org",
      log: () => undefined,
    };
    const actor: Actor = {
      user: {
        id: owner,
        email: `owner-${suffix}@example.org`,
        displayName: "Owner",
        isAdmin: false,
        isSupport: false,
        isAuditor: false,
        instanceRoles: [],
      },
      bindings: await loadBindings(db, owner),
    };
    const list = (...conditions: Condition[]) =>
      listRecords(deps, actor, tableId, {
        filter: JSON.stringify(rule(...conditions)),
      });
    for (const bad of [
      { column: "amount", op: "gt", value: "ten" },
      { column: "paid", op: "is", value: "true" },
      { column: "day", op: "is", value: "not a date" },
      { column: "amount", op: "is_between", value: ["1", "ten"] },
    ]) {
      expect(await errorCode(list(bad))).toBe("invalid_filter");
    }
    expect(
      (await list({ column: "amount", op: "gt", value: "25" })).records,
    ).toHaveLength(2);
    // A condition not filled in yet still leaves out nothing.
    expect(
      (await list({ column: "region", op: "is", value: "" })).records,
    ).toHaveLength(4);
  });
});
