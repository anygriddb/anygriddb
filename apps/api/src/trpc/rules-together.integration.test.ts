/**
 * What several attributions give together on one table (ADR 0144), through
 * the real router on a migrated database: each gives its fields on its own
 * rows, never on the rows another reaches, for reading as for writing, by
 * every way a value is read.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { addLocalGroupMember, createLocalGroup } from "../scim/groups.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { errorCode, plainBrowsers } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("what several rules give together", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const page = plainBrowsers(() => db)();
  const ids = { owner: "", nina: "" };
  const tokens = { owner: "", nina: "" };
  let tableId = "";
  let visitsId = "";
  let groupId = "";
  const rowIds = { alba: "", boris: "" };

  const as = (who: keyof typeof tokens) =>
    page.call({ authorization: `Bearer ${tokens[who]}` });
  /** Each row the reader reads, with one field or nothing. */
  const seen = async (field = "diagnosis", extra: object = {}) =>
    Object.fromEntries(
      (await as("nina").rows.read({ tableId, limit: 100, ...extra })).rows.map(
        (row) => [String(row.name), row[field] ?? null],
      ),
    );
  const ward3 = {
    conjunction: "and" as const,
    conditions: [{ column: "ward", op: "is" as const, value: "3" }],
  };
  /** The ward's role, and Nina's own on every row without a diagnosis. */
  const giveBoth = async (role: "viewer" | "editor", own: "hide" | "read") => {
    await as("owner").catalog.setTableRole({ tableId, groupId, role });
    await as("owner").catalog.setTableAcl({
      tableId,
      groupId,
      rowFilter: ward3,
      columns: [],
    });
    await as("owner").catalog.setTableRole({
      tableId,
      userId: ids.nina,
      role,
    });
    const write = role === "editor" ? "write" : "read";
    await as("owner").catalog.setTableAcl({
      tableId,
      userId: ids.nina,
      rowFilter: null,
      columns: [
        { column: "name", access: write },
        { column: "ward", access: write },
        { column: "diagnosis", access: own },
        { column: "shout", access: "read" },
      ],
    });
  };

  beforeAll(async () => {
    const created = await createTestDatabase("rules_together");
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
    const baseId = (await insertBase(db, ids.owner, { name: "Ward" })).id;
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
    await as("owner").catalog.addColumn({
      tableId,
      name: "shout",
      label: "Shout",
      fieldType: "formula",
      formulaSource: "UPPER({diagnosis})",
    });
    await as("owner").rows.insertMany({
      tableId,
      rows: [
        { name: "Alba", ward: "3", diagnosis: "flu" },
        { name: "Boris", ward: "4", diagnosis: "cold" },
      ],
    });
    for (const row of (await as("owner").rows.read({ tableId, limit: 10 }))
      .rows) {
      rowIds[String(row.name).toLowerCase() as keyof typeof rowIds] = row.id;
    }
    // Boris's diagnosis has a history.
    await as("owner").rows.updateMany({
      tableId,
      updates: [{ rowId: rowIds.boris, values: { diagnosis: "a cold" } }],
    });
    // Visits link to patients, and look their diagnosis up.
    visitsId = (
      await insertTable(db, ids.owner, {
        baseId,
        name: "Visits",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    await as("owner").catalog.addRelation({
      tableId: visitsId,
      name: "patient",
      kind: "many_to_many",
      targetTableId: tableId,
    });
    await as("owner").catalog.addLookup({
      tableId: visitsId,
      name: "patient_diagnosis",
      label: "Diagnosis",
      relation: "patient",
      target: "diagnosis",
    });
    for (const [name, patient] of [
      ["Visit of Alba", rowIds.alba],
      ["Visit of Boris", rowIds.boris],
    ] as const) {
      await as("owner").rows.insertMany({
        tableId: visitsId,
        rows: [{ name }],
      });
      const visit = (
        await as("owner").rows.read({ tableId: visitsId, limit: 10 })
      ).rows.find((row) => row.name === name);
      await as("owner").rows.setLinks({
        tableId: visitsId,
        rowId: String(visit?.id),
        column: "patient",
        targetIds: [patient],
      });
    }
    groupId = (
      await createLocalGroup(db, ids.owner, {
        displayName: `Ward 3 ${suffix}`,
        description: null,
      })
    ).id;
    await addLocalGroupMember(db, ids.owner, { groupId, userId: ids.nina });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("shows each attribution's fields on its own rows only", async () => {
    await giveBoth("viewer", "hide");
    // Every row, and a diagnosis only where the ward's role shows it.
    expect(await seen()).toEqual({ Alba: "flu", Boris: null });
    // A formula over it reads it empty there too.
    expect(await seen("shout")).toEqual({ Alba: "FLU", Boris: null });
    // Each row says which of its fields it hides, so empty is not taken
    // for hidden; a formula no rule hides computes on what she sees.
    expect(await seen("ag_hidden")).toEqual({
      Alba: {},
      Boris: { diagnosis: "hidden" },
    });
    // So does a lookup from a table she reads whole.
    await as("owner").catalog.setTableRole({
      tableId: visitsId,
      userId: ids.nina,
      role: "viewer",
    });
    const visits = await as("nina").rows.read({ tableId: visitsId, limit: 10 });
    expect(
      Object.fromEntries(
        visits.rows.map((row) => [row.name, row.patient_diagnosis]),
      ),
    ).toEqual({ "Visit of Alba": ["flu"], "Visit of Boris": [null] });
  });

  it("lets no filter, search, count, or row read find the value it hides", async () => {
    const cold = {
      conjunction: "and" as const,
      conditions: [
        { column: "diagnosis", op: "contains" as const, value: "cold" },
      ],
    };
    expect(await seen("diagnosis", { filter: cold })).toEqual({});
    expect(await seen("diagnosis", { search: "cold" })).toEqual({});
    const { values } = await as("nina").rows.aggregate({
      tableId,
      items: [{ column: "diagnosis", fn: "count_filled" }],
    });
    expect(values).toEqual([1]);
    const { rows } = await as("nina").rows.get({
      tableId,
      rowIds: [rowIds.boris],
    });
    expect(rows[0]?.diagnosis ?? null).toBeNull();
  });

  it("keeps a hidden field's past out of the row's history", async () => {
    const history = await as("nina").rows.audit({
      tableId,
      recordId: rowIds.boris,
    });
    expect(JSON.stringify(history.events)).not.toContain("cold");
    expect(JSON.stringify(history.events)).toContain("Boris");
    const shown = await as("nina").rows.audit({
      tableId,
      recordId: rowIds.alba,
    });
    expect(JSON.stringify(shown.events)).toContain("flu");
  });

  it("writes each attribution's fields on its own rows only", async () => {
    await giveBoth("editor", "read");
    const update = (rowId: string, values: Record<string, string>) =>
      errorCode(
        as("nina").rows.updateMany({
          tableId,
          updates: [{ rowId, values }],
        }),
      );
    expect(await update(rowIds.alba, { diagnosis: "flu, better" })).toBe("ok");
    expect(await update(rowIds.boris, { diagnosis: "a cold" })).toBe(
      "access_denied",
    );
    // What her own role lets her write, she writes everywhere.
    expect(await update(rowIds.boris, { name: "Boris B." })).toBe("ok");
    // A new row takes a diagnosis only where the ward's role reaches.
    const add = (ward: string) =>
      errorCode(
        as("nina").rows.insertMany({
          tableId,
          rows: [{ name: `New ${ward}`, ward, diagnosis: "sprain" }],
        }),
      );
    expect(await add("4")).not.toBe("ok");
    expect(await add("3")).toBe("ok");
    // Her own role reads the diagnosis everywhere, and writes it nowhere.
    expect(await seen()).toMatchObject({
      Alba: "flu, better",
      "Boris B.": "a cold",
      "New 3": "sprain",
    });
  });
});
