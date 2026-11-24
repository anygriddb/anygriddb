/**
 * The comments of a base's rows in its copies (ADR 0122), against a real
 * database: a restore point and a copy made by the instance bring each
 * thread back on its row, as it was; a file a person downloads carries
 * none, and a file from elsewhere could not bring any.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { madeNames } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStore } from "../files/index.js";
import { jobRunners } from "../job-runners.js";
import type { JobRow } from "../jobs.js";
import { createTestDatabase } from "../test-database.js";
import { ERASED_USER_ID, eraseAccount } from "./erasure.js";
import { importBaseSnapshot } from "./base-snapshot.js";
import { duplicateTable } from "./data-ops.js";
import { loadEngine } from "./engine.js";
import { makeRestorePoint, restoreFromPoint } from "./restore-points.js";
import { insertRows } from "./rows.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { snapshotOf } from "./snapshot.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("the comments of a base's rows in its copies", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let files: DiskStore;
  let owner = "";
  let ada = "";
  let bob = "";
  let baseId = "";
  let notes = "";
  const deps = () => ({ db, files, maxRows: 1_000_000 });
  const restoreDeps = () => ({
    ...deps(),
    maxFileBytes: 1024 * 1024,
    names: madeNames(),
  });

  async function tableOf(base: string): Promise<string> {
    const found = await db
      .selectFrom("dataTables")
      .select("id")
      .where("baseId", "=", base)
      .where("name", "=", "Notes")
      .executeTakeFirstOrThrow();
    return found.id;
  }

  /** A table's comments as a reader sees them, by their row's number. */
  async function commentsOf(tableId: string) {
    const { physicalName } = await db
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", tableId)
      .executeTakeFirstOrThrow();
    const at = (column: string) =>
      sql<
        string | null
      >`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
    const { rows } = await sql<{
      row: string;
      body: string;
      author: string;
      answers: string | null;
      createdAt: string;
      updatedAt: string | null;
      deletedAt: string | null;
      resolvedAt: string | null;
      resolvedBy: string | null;
    }>`select t."ag_seq"::text as "row", c.body, c.author_id::text as "author",
        p.body as "answers", ${at("c.created_at")} as "createdAt",
        ${at("c.updated_at")} as "updatedAt", ${at("c.deleted_at")} as "deletedAt",
        ${at("c.resolved_at")} as "resolvedAt", c.resolved_by::text as "resolvedBy"
      from comments c
      join ${sql.table(physicalName)} t on t.id::text = c.row_id
      left join comments p on p.id = c.parent_id
      where c.table_id = ${tableId}
      order by t."ag_seq", c.created_at, c.body`.execute(db);
    return rows;
  }

  beforeAll(async () => {
    const created = await createTestDatabase("snapshot_comments");
    db = created.db;
    close = created.close;
    files = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-")));
    [owner, ada, bob] = (
      await db
        .insertInto("users")
        .values([
          { email: `owner-${suffix}@example.com`, displayName: "Owner" },
          { email: `ada-${suffix}@example.com`, displayName: "Ada" },
          { email: `bob-${suffix}@example.com`, displayName: "Bob" },
        ])
        .returning("id")
        .execute()
    ).map((row) => row.id) as [string, string, string];
    baseId = (await insertBase(db, owner, { name: "Ward" })).id;
    notes = (
      await insertTable(db, owner, {
        baseId,
        name: "Notes",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    const { engine } = await loadEngine(db, notes, () => true);
    const { physicalName } = await db
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", notes)
      .executeTakeFirstOrThrow();
    const [first, second] = (await insertRows(
      db,
      engine,
      {
        userId: owner,
        tableId: notes,
        physicalName,
        baseId,
        reason: null,
        source: "test",
      },
      [{ name: "First" }, { name: "Second" }, { name: "Third" }],
    )) as [string, string, string];
    const day = (n: number) => `2026-11-0${String(n)}T10:00:00.000001Z`;
    const question = randomUUID();
    await db
      .insertInto("comments")
      .values([
        {
          id: question,
          tableId: notes,
          rowId: first,
          authorId: ada,
          body: "Is the dose right?",
          createdAt: day(1),
          resolvedAt: day(4),
          resolvedBy: owner,
        },
        {
          tableId: notes,
          rowId: first,
          authorId: owner,
          body: "Checked, it is.",
          parentId: question,
          createdAt: day(2),
          updatedAt: day(3),
        },
        {
          tableId: notes,
          rowId: second,
          authorId: bob,
          body: "Call the family.",
          createdAt: day(5),
        },
        {
          tableId: notes,
          rowId: second,
          authorId: ada,
          body: "Taken back.",
          createdAt: day(6),
          deletedAt: day(7),
        },
      ])
      .execute();
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("brings each thread back on its row from a restore point", async () => {
    const before = await commentsOf(notes);
    expect(before).toHaveLength(4);
    const point = await makeRestorePoint(deps(), { userId: owner, baseId });
    const restored = await restoreFromPoint(restoreDeps(), {
      userId: owner,
      restorePointId: point.id,
      name: "Ward (restored)",
    });
    expect(await commentsOf(await tableOf(restored.baseId))).toEqual(before);
  }, 60_000);

  it("gives a comment by an account erased since the point to its placeholder", async () => {
    const point = await makeRestorePoint(deps(), { userId: owner, baseId });
    await eraseAccount(db, bob);
    const restored = await restoreFromPoint(restoreDeps(), {
      userId: owner,
      restorePointId: point.id,
      name: "Ward (restored, Bob gone)",
    });
    const after = await commentsOf(await tableOf(restored.baseId));
    expect(
      after.find((comment) => comment.body === "Call the family.")?.author,
    ).toBe(ERASED_USER_ID);
    // The erasure did the same to the base the point was made of.
    expect(await commentsOf(notes)).toEqual(after);
  }, 60_000);

  it("keeps them in a copy of the base", async () => {
    const runners = jobRunners({
      db,
      bus: { publish: async () => undefined } as never,
      files,
      log: () => undefined,
    });
    const outcome = await runners.duplicate_base({
      job: {
        id: randomUUID(),
        userId: owner,
        input: { baseId, name: "Ward (copy)", withData: true },
      } as unknown as JobRow,
      progress: async () => undefined,
    });
    const copy = await tableOf(outcome.result?.baseId as string);
    expect(await commentsOf(copy)).toEqual(await commentsOf(notes));
  }, 60_000);

  it("keeps them in a copy of a table with its rows", async () => {
    const source = await db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", notes)
      .executeTakeFirstOrThrow();
    const copy = await duplicateTable(db, owner, source, {
      name: "Notes (copy)",
      withData: true,
    });
    expect(await commentsOf(copy.id)).toEqual(await commentsOf(notes));
    // A copy without its rows has nothing to put them on.
    const empty = await duplicateTable(db, owner, source, {
      name: "Notes (empty)",
      withData: false,
    });
    expect(await commentsOf(empty.id)).toEqual([]);
  }, 60_000);

  it("leaves them out of a file a person downloads, and of a base made of it", async () => {
    const written = await snapshotOf(db, files, baseId, { withData: true });
    try {
      expect(written.snapshot.tables[0]?.comments).toBeUndefined();
      const imported = await importBaseSnapshot(
        db,
        files,
        owner,
        written.snapshot,
        {
          name: "Ward (imported)",
          readLines: written.readLines,
          maxRows: 1_000_000,
        },
      );
      expect(await commentsOf(await tableOf(imported.baseId))).toEqual([]);
    } finally {
      await written.close();
    }
  }, 60_000);
});
