/**
 * A table copied with its rows in SQL (ADR 0065): past one chunk, in its
 * order and with its numbers, its links to other tables as they were, and
 * its links to itself pointing at the copied rows.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { runRows, withAudit } from "./audit-context.js";
import { duplicateTable } from "./data-ops.js";
import { createFolder, moveTableToFolder } from "./folders.js";
import { loadEngine } from "./engine.js";
import { addRelation, setLinks } from "./relations.js";
import { readPage } from "./rows.js";
import { insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");
const ROWS = 6_001;

describe("a table copied with its rows", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let teamsId = "";
  let tasksId = "";
  let folderId = "";

  async function tableRow(id: string) {
    return db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  async function engineOf(id: string) {
    return (await loadEngine(db, id, () => true)).engine;
  }

  /** The rows of a table whose title is one of `titles`, by title. */
  async function byTitle(tableId: string, titles: readonly string[]) {
    const page = await readPage(
      db,
      await engineOf(tableId),
      {
        limit: titles.length,
        filter: {
          conjunction: "or",
          conditions: titles.map((title) => ({
            column: "title",
            op: "is",
            value: title,
          })),
        },
      },
      { total: false },
    );
    return new Map(page.rows.map((row) => [String(row.title), row]));
  }

  function ids(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((link) => String((link as { id: unknown }).id)).sort()
      : [];
  }

  beforeAll(async () => {
    const created = await createTestDatabase("duplicate");
    db = created.db;
    close = created.close;
    owner = (
      await db
        .insertInto("users")
        .values({ email: `owner-${suffix}@example.com`, displayName: "Owner" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const baseId = (await insertBase(db, owner, { name: "Work" })).id;
    teamsId = (
      await insertTable(db, owner, {
        baseId,
        name: "Teams",
        columns: [{ label: "Title", fieldType: "text" }],
      })
    ).id;
    tasksId = (
      await insertTable(db, owner, {
        baseId,
        name: "Tasks",
        columns: [
          { label: "Title", fieldType: "text" },
          { label: "Qty", fieldType: "number" },
        ],
      })
    ).id;
    for (const [tableId, name, kind, targetTableId] of [
      [tasksId, "team", "one_to_many", teamsId],
      [tasksId, "parent", "one_to_many", tasksId],
      [tasksId, "related", "many_to_many", tasksId],
      [tasksId, "helpers", "many_to_many", teamsId],
    ] as const) {
      await addRelation(db, owner, {
        tableId,
        name,
        label: name,
        kind,
        targetTableId,
      });
    }
    folderId = (await createFolder(db, owner, { baseId, name: "Planning" })).id;
    await moveTableToFolder(db, owner, { tableId: tasksId, folderId });
    const teams = await tableRow(teamsId);
    const tasks = await tableRow(tasksId);
    await withAudit(db, { userId: owner, tableId: teamsId }, (tx) =>
      runRows(tx, {
        text: `insert into "${teams.physicalName}" ("title") values ('Red'), ('Blue')`,
        values: [],
      }),
    );
    await withAudit(db, { userId: owner, tableId: tasksId }, async (tx) => {
      await runRows(tx, {
        text: `insert into "${tasks.physicalName}" ("title", "qty") select 'T' || g, g from generate_series(1, $1::int) g`,
        values: [ROWS],
      });
      // T3 is moved above T1: the copy keeps the order people gave.
      await runRows(tx, {
        text: `update "${tasks.physicalName}" set "ag_position" = -1 where "title" = 'T3'`,
        values: [],
      });
    });
    const teamRows = await byTitle(teamsId, ["Red", "Blue"]);
    const taskRows = await byTitle(tasksId, ["T1", "T2", "T6000", "T6001"]);
    const engine = await engineOf(tasksId);
    const link = (
      row: string,
      field: string,
      targets: Array<string | undefined>,
    ) => {
      const column = engine.table.columns.find((item) => item.name === field);
      if (!column) throw new Error(field);
      return setLinks(db, engine, {
        userId: owner,
        tableId: tasksId,
        physicalName: tasks.physicalName,
        column,
        rowId: String(taskRows.get(row)?.id),
        targetIds: targets.map(String),
        reason: null,
      });
    };
    await link("T1", "team", [String(teamRows.get("Red")?.id)]);
    await link("T1", "parent", [String(taskRows.get("T6001")?.id)]);
    await link("T6001", "parent", [String(taskRows.get("T1")?.id)]);
    await link("T1", "related", [
      String(taskRows.get("T2")?.id),
      String(taskRows.get("T6000")?.id),
    ]);
    await link("T1", "helpers", [String(teamRows.get("Blue")?.id)]);
  }, 180_000);

  afterAll(async () => {
    await close?.();
  });

  it("copies every row in chunks, with its links, its order, and its number", async () => {
    const steps: Array<[number, number | null]> = [];
    const copy = await duplicateTable(db, owner, await tableRow(tasksId), {
      name: "Tasks (copy)",
      withData: true,
      onProgress: async (done, total) => {
        steps.push([done, total]);
      },
    });
    expect(steps).toEqual([
      [0, ROWS],
      [5_000, ROWS],
      [ROWS, ROWS],
    ]);
    // Beside its source, in the same folder.
    expect((await tableRow(copy.id)).folderId).toBe(folderId);
    const engine = await engineOf(copy.id);
    const first = await readPage(db, engine, { limit: 2 }, { total: true });
    expect(first.total).toBe(ROWS);
    expect(first.rows.map((row) => row.title)).toEqual(["T3", "T1"]);

    const source = await byTitle(tasksId, ["T1", "T6001"]);
    const copied = await byTitle(copy.id, ["T1", "T2", "T6000", "T6001"]);
    const t1 = copied.get("T1");
    const teams = await byTitle(teamsId, ["Red", "Blue"]);
    // The same number, a new id.
    expect(t1?.ag_seq).toBe(source.get("T1")?.ag_seq);
    expect(t1?.id).not.toBe(source.get("T1")?.id);
    // Other tables' rows stay the ones linked; the table's own, their copies.
    expect(ids(t1?.team)).toEqual([String(teams.get("Red")?.id)]);
    expect(ids(t1?.helpers)).toEqual([String(teams.get("Blue")?.id)]);
    expect(ids(t1?.parent)).toEqual([String(copied.get("T6001")?.id)]);
    expect(ids(copied.get("T6001")?.parent)).toEqual([String(t1?.id)]);
    expect(ids(t1?.related)).toEqual(
      [String(copied.get("T2")?.id), String(copied.get("T6000")?.id)].sort(),
    );

    // A row added to the copy takes a number none of its rows has.
    const table = await tableRow(copy.id);
    const [added] = await withAudit(
      db,
      { userId: owner, tableId: copy.id },
      (tx) =>
        runRows(tx, {
          text: `insert into "${table.physicalName}" ("title") values ('New') returning "ag_seq"`,
          values: [],
        }),
    );
    expect(Number(added?.ag_seq)).toBeGreaterThan(ROWS);

    // The trail has each row written, and the links set after it.
    const trail = await db
      .selectFrom("auditEvents")
      .select(["action", "recordId", "newValue"])
      .where("tableId", "=", copy.id)
      .where("source", "=", "duplicate")
      .execute();
    expect(trail.filter((event) => event.action === "insert")).toHaveLength(
      ROWS,
    );
    const linked = trail.filter(
      (event) => event.action === "update" && event.recordId === String(t1?.id),
    );
    expect(
      linked
        .map((event) => Object.keys(event.newValue as object))
        .flat()
        .sort(),
    ).toEqual(expect.arrayContaining(["helpers", "related"]));
  });
});
