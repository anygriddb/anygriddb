/**
 * A field shown on some of a rule's rows only (ADR 0145), through the real
 * router on a migrated database: one group's rule reads every ward's
 * patients, and the diagnosis only on the reader's own ward.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import {
  createAttribute,
  setAccountAttributes,
} from "../data/person-attributes.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { addLocalGroupMember, createLocalGroup } from "../scim/groups.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { errorCode, plainBrowsers } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("a field shown on some of a rule's rows", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const page = plainBrowsers(() => db)();
  const ids = { owner: "", nina: "", nate: "" };
  const tokens = { owner: "", nina: "", nate: "" };
  let tableId = "";
  let groupId = "";
  const rowIds: Record<string, string> = {};

  const as = (who: keyof typeof tokens) =>
    page.call({ authorization: `Bearer ${tokens[who]}` });
  const seen = async (who: keyof typeof tokens) =>
    Object.fromEntries(
      (await as(who).rows.read({ tableId, limit: 100 })).rows.map((row) => [
        String(row.name),
        row.diagnosis ?? null,
      ]),
    );
  const myWard = {
    conjunction: "and" as const,
    conditions: [
      { column: "ward", op: "is" as const, value: { attribute: "ward" } },
    ],
  };
  const rule = (access: "read" | "write", rows: unknown = myWard) => ({
    tableId,
    groupId,
    rowFilter: null,
    columns: [
      { column: "name", access: "read" as const },
      { column: "ward", access: "read" as const },
      { column: "diagnosis", access, rows: rows as typeof myWard },
    ],
  });

  beforeAll(async () => {
    const created = await createTestDatabase("field_rows");
    db = created.db;
    close = created.close;
    for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
      ids[name] = (
        await db
          .insertInto("users")
          .values({ email: `${name}-${suffix}@example.org`, displayName: name })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
      tokens[name] = (
        await createApiToken(db, ids[name], name, { days: 1 })
      ).token;
    }
    await writeSettings(db, ids.owner, { mfaScope: "admins" });
    await createAttribute(db, ids.owner, {
      key: "ward",
      label: "Ward",
      scimField: null,
    });
    await setAccountAttributes(db, ids.owner, {
      userId: ids.nina,
      values: { ward: ["3"] },
    });
    await setAccountAttributes(db, ids.owner, {
      userId: ids.nate,
      values: { ward: ["4"] },
    });
    const baseId = (await insertBase(db, ids.owner, { name: "Hospital" })).id;
    tableId = (
      await insertTable(db, ids.owner, {
        baseId,
        name: "Patients",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "ward", label: "Ward", fieldType: "text" },
          { name: "diagnosis", label: "Diagnosis", fieldType: "text" },
        ],
      })
    ).id;
    await as("owner").rows.insertMany({
      tableId,
      rows: [
        { name: "Alba", ward: "3", diagnosis: "flu" },
        { name: "Boris", ward: "4", diagnosis: "cold" },
      ],
    });
    for (const row of (await as("owner").rows.read({ tableId, limit: 10 }))
      .rows) {
      rowIds[String(row.name)] = row.id;
    }
    groupId = (
      await createLocalGroup(db, ids.owner, {
        displayName: `Nurses ${suffix}`,
        description: null,
      })
    ).id;
    for (const userId of [ids.nina, ids.nate]) {
      await addLocalGroupMember(db, ids.owner, { groupId, userId });
    }
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("shows every row, and the field only where its condition holds for the reader", async () => {
    await as("owner").catalog.setTableRole({
      tableId,
      groupId,
      role: "viewer",
    });
    await as("owner").catalog.setTableAcl(rule("read"));
    expect(await seen("nina")).toEqual({ Alba: "flu", Boris: null });
    expect(await seen("nate")).toEqual({ Alba: null, Boris: "cold" });
    // The rule lists the field's rows as it was given them.
    const { rules } = await as("owner").catalog.tableAcl({ tableId });
    expect(rules[0]?.columns).toContainEqual({
      column: "diagnosis",
      access: "read",
      rows: myWard,
    });
    // Its past too, on the rows it is hidden on.
    const history = await as("nina").rows.audit({
      tableId,
      recordId: rowIds.Boris ?? "",
    });
    expect(JSON.stringify(history.events)).not.toContain("cold");
  });

  it("writes the field only where its condition holds", async () => {
    await as("owner").catalog.setTableRole({
      tableId,
      groupId,
      role: "editor",
    });
    await as("owner").catalog.setTableAcl(rule("write"));
    const update = (row: string, diagnosis: string) =>
      errorCode(
        as("nina").rows.updateMany({
          tableId,
          updates: [{ rowId: rowIds[row] ?? "", values: { diagnosis } }],
        }),
      );
    expect(await update("Alba", "flu, better")).toBe("ok");
    expect(await update("Boris", "a cold")).toBe("access_denied");
    expect(await seen("nate")).toEqual({ Alba: null, Boris: "cold" });
  });

  it("refuses a field's rows that do not hold, or that hide a field already hidden", async () => {
    expect(
      await errorCode(
        as("owner").catalog.setTableAcl(
          rule("read", {
            conjunction: "and",
            conditions: [
              { column: "ward", op: "is", value: { attribute: "site" } },
            ],
          }),
        ),
      ),
    ).toBe("unknown_attribute");
    expect(
      await errorCode(
        as("owner").catalog.setTableAcl(
          rule("read", {
            conjunction: "and",
            conditions: [{ column: "ward", op: "is", value: "" }],
          }),
        ),
      ),
    ).toBe("invalid_filter");
    expect(
      await errorCode(
        as("owner").catalog.setTableAcl({
          ...rule("read"),
          columns: [{ column: "diagnosis", access: "hide", rows: myWard }],
        }),
      ),
    ).toBe("BAD_REQUEST");
    // What was set before holds.
    expect(await seen("nina")).toEqual({ Alba: "flu, better", Boris: null });
  });
});
