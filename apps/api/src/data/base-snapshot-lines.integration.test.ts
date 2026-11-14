/**
 * Base snapshots past what one JSON document holds (ADR 0076), against a
 * real database: every table's rows written as the lines of their entry,
 * read back a batch at a time, and linked through the sequence numbers
 * they keep.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiskStore } from "../files/index.js";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import { importBaseSnapshot } from "./base-snapshot.js";
import { loadEngine } from "./engine.js";
import { addRelation } from "./relations.js";
import { insertRows } from "./rows.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { openStagedSnapshot, stageSnapshotFile } from "./snapshot-stage.js";
import { snapshotOf } from "./snapshot.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const TASKS = 2_500;

describe("snapshots read and written line by line", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let files: DiskStore;
  let owner = "";
  let baseId = "";

  /** A table's physical name and a link field's storage. */
  async function storage(tableId: string) {
    const { engine, rows } = await loadEngine(db, tableId, () => true);
    const physical = rows.tables.find((item) => item.id === tableId);
    if (!physical) throw new Error("no table");
    const relation = (name: string) => {
      const found = engine.table.columns.find((column) => column.name === name);
      if (!found?.relation) throw new Error(`no link ${name}`);
      return found.relation;
    };
    return { engine, physical: physical.physicalName, relation };
  }

  async function tablesOf(id: string) {
    const tables = await db
      .selectFrom("dataTables")
      .select(["id", "name"])
      .where("baseId", "=", id)
      .execute();
    const find = (name: string) => {
      const found = tables.find((table) => table.name === name);
      if (!found) throw new Error(`no table ${name}`);
      return found.id;
    };
    return { tasks: find("Tasks"), teams: find("Teams") };
  }

  /**
   * What a base's tasks are, in their order: each one's number, title,
   * team, parent, and the tasks it blocks, by title.
   */
  async function contentOf(id: string) {
    const { tasks, teams } = await tablesOf(id);
    const t = await storage(tasks);
    const m = await storage(teams);
    const team = t.relation("team").fkColumn ?? "";
    const parent = t.relation("parent").fkColumn ?? "";
    const junction = t.relation("blocks").junction ?? "";
    const result = await sql<{
      seq: string;
      title: string;
      team: string | null;
      parent: string | null;
      blocks: string[] | null;
    }>`select r."ag_seq"::text as "seq", r."title", g."name" as "team", p."title" as "parent", (select array_agg(b."title" order by b."title") from ${sql.table(junction)} j join ${sql.table(t.physical)} b on b."id" = j."right_id" where j."left_id" = r."id") as "blocks" from ${sql.table(t.physical)} r left join ${sql.table(m.physical)} g on g."id" = r.${sql.ref(team)} left join ${sql.table(t.physical)} p on p."id" = r.${sql.ref(parent)} order by r."ag_position", r."ag_seq"`.execute(
      db,
    );
    return result.rows;
  }

  beforeAll(async () => {
    const created = await createTestDatabase("snapshot-lines");
    db = created.db;
    close = created.close;
    files = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-")));
    owner = (
      await db
        .insertInto("users")
        .values({ email: `lines-${suffix}@example.com`, displayName: "Owner" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    baseId = (await insertBase(db, owner, { name: "Projets" })).id;
    const teams = (
      await insertTable(db, owner, {
        baseId,
        name: "Teams",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    const tasks = (
      await insertTable(db, owner, {
        baseId,
        name: "Tasks",
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "done", label: "Done", fieldType: "boolean" },
        ],
      })
    ).id;
    await addRelation(db, owner, {
      tableId: tasks,
      name: "team",
      label: "Team",
      kind: "one_to_many",
      targetTableId: teams,
      twoWay: true,
      inverseLabel: "Tasks",
    });
    await addRelation(db, owner, {
      tableId: tasks,
      name: "parent",
      label: "Parent",
      kind: "one_to_many",
      targetTableId: tasks,
      twoWay: false,
    });
    await addRelation(db, owner, {
      tableId: tasks,
      name: "blocks",
      label: "Blocks",
      kind: "many_to_many",
      targetTableId: tasks,
      twoWay: true,
      inverseLabel: "Blocked by",
    });

    const context = (tableId: string, physicalName: string) => ({
      userId: owner,
      tableId,
      physicalName,
      baseId,
      reason: null,
      source: "test",
    });
    const m = await storage(teams);
    await insertRows(db, m.engine, context(teams, m.physical), [
      { name: "Red" },
      { name: "Green" },
      { name: "Blue" },
    ]);
    const t = await storage(tasks);
    await insertRows(
      db,
      t.engine,
      context(tasks, t.physical),
      Array.from({ length: TASKS }, (_, index) => ({
        title: `Task ${String(index + 1).padStart(4, "0")}`,
        done: index % 3 === 0,
      })),
    );
    const team = t.relation("team").fkColumn ?? "";
    const parent = t.relation("parent").fkColumn ?? "";
    const junction = t.relation("blocks").junction ?? "";
    await withAudit(db, { userId: owner, tableId: tasks }, async (tx) => {
      // Each task in a team, a parent for one in ten, two tasks blocked by
      // each: more pairs than one statement links.
      await sql`update ${sql.table(t.physical)} r set ${sql.ref(team)} = g."id" from ${sql.table(m.physical)} g where g."ag_seq" = 1 + r."ag_seq" % 3`.execute(
        tx,
      );
      await sql`update ${sql.table(t.physical)} r set ${sql.ref(parent)} = p."id" from ${sql.table(t.physical)} p where p."ag_seq" = r."ag_seq" - 1 and r."ag_seq" % 10 = 0`.execute(
        tx,
      );
      await sql`insert into ${sql.table(junction)} ("left_id", "right_id") select r."id", b."id" from ${sql.table(t.physical)} r join ${sql.table(t.physical)} b on b."ag_seq" in (r."ag_seq" + 1, r."ag_seq" + 2)`.execute(
        tx,
      );
      // Holes in the numbers, and rows put in another order by hand.
      await sql`delete from ${sql.table(t.physical)} where "ag_seq" in (7, 1500, 2499)`.execute(
        tx,
      );
      await sql`update ${sql.table(t.physical)} set "ag_position" = -1.5 where "ag_seq" = 2000`.execute(
        tx,
      );
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("brings every row back with its number, place, and links, through an upload", async () => {
    const written = await snapshotOf(db, files, baseId, { withData: true });
    try {
      // The three teams, and every task but the three removed.
      expect(written.rows).toBe(3 + TASKS - 3);
      const counts = Object.fromEntries(
        written.snapshot.tables.map((table) => [table.name, table.rowCount]),
      );
      expect(counts).toEqual({ Teams: 3, Tasks: TASKS - 3 });
      if (written.packed.kind !== "zip") throw new Error("not an archive");
      const staged = await stageSnapshotFile(db, files, {
        userId: owner,
        path: written.packed.path,
        size: written.packed.size,
        filename: written.packed.filename,
      });
      const opened = await openStagedSnapshot(
        db,
        files,
        staged.snapshotId,
        owner,
      );
      const seen: number[] = [];
      const imported = await importBaseSnapshot(
        db,
        files,
        owner,
        opened.snapshot,
        {
          name: "Projets (restored)",
          readFile: opened.readFile,
          readLines: opened.readLines,
          maxRows: 1_000_000,
          onProgress: async (done) => {
            seen.push(done);
          },
        },
      ).finally(opened.close);
      // Progress only moves forward, and reaches its end.
      expect(seen).toEqual([...seen].sort((a, b) => a - b));

      const before = await contentOf(baseId);
      const after = await contentOf(imported.baseId);
      expect(after).toHaveLength(TASKS - 3);
      expect(after).toEqual(before);
      expect(after[0]).toMatchObject({ seq: "2000", title: "Task 2000" });
      const blocked = after.find((row) => row.seq === "10");
      expect(blocked).toMatchObject({
        team: "Green",
        parent: "Task 0009",
        blocks: ["Task 0011", "Task 0012"],
      });

      // A task added to the copy takes a number and a place after the
      // ones it kept.
      const { tasks } = await tablesOf(imported.baseId);
      const t = await storage(tasks);
      await insertRows(
        db,
        t.engine,
        {
          userId: owner,
          tableId: tasks,
          physicalName: t.physical,
          baseId: imported.baseId,
          reason: null,
          source: "test",
        },
        [{ title: "Added later" }],
      );
      const last = (await contentOf(imported.baseId)).at(-1);
      expect(last?.title).toBe("Added later");
      expect(Number(last?.seq)).toBeGreaterThan(TASKS);
    } finally {
      await written.close();
    }
  }, 120_000);

  it("refuses a base past the ceiling, both ways, and a file whose counts lie", async () => {
    await expect(
      snapshotOf(db, files, baseId, { withData: true, maxRows: 100 }),
    ).rejects.toThrow("Too many rows for one base file");

    const written = await snapshotOf(db, files, baseId, { withData: true });
    try {
      await expect(
        importBaseSnapshot(db, files, owner, written.snapshot, {
          readLines: written.readLines,
          maxRows: 100,
        }),
      ).rejects.toThrow("Too many rows for one base file");

      const bases = async () =>
        (
          await db
            .selectFrom("bases")
            .select("id")
            .where("deletedAt", "is", null)
            .execute()
        ).length;
      const count = await bases();
      const lying = {
        ...written.snapshot,
        tables: written.snapshot.tables.map((table) =>
          table.name === "Teams" ? { ...table, rowCount: 2 } : table,
        ),
      };
      await expect(
        importBaseSnapshot(db, files, owner, lying, {
          readLines: written.readLines,
          maxRows: 1_000_000,
        }),
      ).rejects.toThrow("Invalid snapshot");
      // The half-made base went with the failure.
      expect(await bases()).toBe(count);
    } finally {
      await written.close();
    }
  }, 120_000);
});
