/**
 * A table past the ceiling of what is read whole (`copy.max_rows`),
 * against a real database: an export, a copy of a field and an import by
 * key are refused, never cut, even where the table's statistics, taken
 * before it grew, say it holds fewer rows.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import { exportTable } from "../data-transfer.js";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import { duplicateColumn, MAX_COPY_ROWS, readAll } from "./data-ops.js";
import { loadEngine } from "./engine.js";
import { importIntoTable, rowsSource } from "./import-commit.js";
import { insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");

describe("a table past the ceiling of a whole read", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let folder = "";
  let owner = "";
  let baseId = "";

  async function table(name: string, rows: number) {
    const { id } = await insertTable(db, owner, {
      baseId,
      name,
      columns: [{ name: "k", label: "K", fieldType: "text" }],
    });
    const row = await db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    await grow(row.id, row.physicalName, 0, rows);
    return row;
  }

  async function grow(id: string, physical: string, from: number, to: number) {
    await withAudit(db, { userId: owner, tableId: id, source: "web" }, (tx) =>
      sql
        .raw(
          `insert into "${physical}" ("k") select 'k' || i from generate_series(${String(from + 1)}, ${String(to)}) i`,
        )
        .execute(tx),
    );
  }

  const readCount = async (id: string, max: number) => {
    const { engine } = await loadEngine(db, id, () => true);
    let read = 0;
    await readAll(
      db,
      engine,
      ["k"],
      (page) => {
        read += page.length;
      },
      {},
      max,
    );
    return read;
  };

  beforeAll(async () => {
    const created = await createTestDatabase("read_all_ceiling");
    db = created.db;
    close = created.close;
    folder = await mkdtemp(join(tmpdir(), "read-all-ceiling-"));
    owner = (
      await db
        .insertInto("users")
        .values({ email: `owner-${suffix}@example.org`, displayName: "Olive" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    baseId = (await insertBase(db, owner, { name: "Stock" })).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
    await rm(folder, { recursive: true, force: true });
  });

  it("reads a table whole up to the ceiling, and refuses one row past it", async () => {
    const small = await table("Small", 2_500);
    expect(await readCount(small.id, 2_500)).toBe(2_500);
    await expect(readCount(small.id, 2_000)).rejects.toMatchObject({
      code: "too_many_rows",
    });
  });

  it("refuses an export, a copy and an import by key that its statistics would let through", async () => {
    // Analyzed at the ceiling, then grown by less than autovacuum waits for.
    const grown = await table("Grown", MAX_COPY_ROWS);
    await sql.raw(`analyze "${grown.physicalName}"`).execute(db);
    await grow(
      grown.id,
      grown.physicalName,
      MAX_COPY_ROWS,
      MAX_COPY_ROWS + 500,
    );

    const path = join(folder, "grown.csv");
    await expect(
      exportTable(
        { db },
        { userId: owner, bindings: await loadBindings(db, owner) },
        grown,
        { format: "csv" },
        { path, maxRows: MAX_COPY_ROWS },
      ),
    ).rejects.toMatchObject({ code: "export_too_large" });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

    const fields = () =>
      db
        .selectFrom("dataColumns")
        .select("name")
        .where("tableId", "=", grown.id)
        .execute();
    const before = await fields();
    await expect(duplicateColumn(db, owner, grown, "k")).rejects.toMatchObject({
      code: "too_many_rows",
    });
    // Refused before the copy is made, not left half filled.
    expect(await fields()).toEqual(before);

    await expect(
      importIntoTable(db, {
        userId: owner,
        table: grown,
        source: rowsSource(["K"], [[`k${String(MAX_COPY_ROWS + 400)}`]]),
        mapping: [{ source: 0, column: "k" }],
        upsertSource: 0,
        addOptions: false,
        canManage: true,
        eventKey: `import:grown-${suffix}`,
      }),
    ).rejects.toMatchObject({ code: "too_many_rows" });

    // Back at the ceiling, the table is read whole.
    await withAudit(
      db,
      { userId: owner, tableId: grown.id, source: "web" },
      (tx) =>
        sql
          .raw(
            `delete from "${grown.physicalName}" where "ag_seq" > ${String(MAX_COPY_ROWS)}`,
          )
          .execute(tx),
    );
    expect(await readCount(grown.id, MAX_COPY_ROWS)).toBe(MAX_COPY_ROWS);
  }, 300_000);
});
