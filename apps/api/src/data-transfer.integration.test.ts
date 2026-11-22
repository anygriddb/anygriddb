/**
 * An export under a search, against a real database: the file holds the
 * rows the search finds, and the count it is checked by is the same.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "./auth/access.js";
import { exportTable } from "./data-transfer.js";
import { loadEngine } from "./data/engine.js";
import { insertRows } from "./data/rows.js";
import { insertBase, insertTable } from "./data/schema-ops.js";
import { createTestDatabase } from "./test-database.js";

const suffix = randomBytes(6).toString("hex");

describe("an export under a search", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let folder = "";
  let owner = "";
  let baseId = "";
  let clients = "";
  let flags = "";

  async function table(id: string) {
    return db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  async function write(tableId: string, rows: Array<Record<string, string>>) {
    const { engine, rows: catalog } = await loadEngine(db, tableId, () => true);
    const physical = catalog.tables.find((item) => item.id === tableId);
    if (!physical) throw new Error("no table");
    await insertRows(
      db,
      engine,
      {
        userId: owner,
        tableId,
        physicalName: physical.physicalName,
        baseId,
        reason: null,
        source: "test",
      },
      rows,
    );
  }

  async function exported(
    tableId: string,
    search: string,
    maxRows = 100,
  ): Promise<{ rows: number; text: string }> {
    const path = join(folder, `${randomBytes(4).toString("hex")}.csv`);
    const { rows } = await exportTable(
      { db },
      { userId: owner, bindings: await loadBindings(db, owner) },
      await table(tableId),
      { format: "csv", search },
      { path, maxRows },
    );
    return { rows, text: await readFile(path, "utf8") };
  }

  beforeAll(async () => {
    const created = await createTestDatabase("export_search");
    db = created.db;
    close = created.close;
    folder = await mkdtemp(join(tmpdir(), "export-search-"));
    owner = (
      await db
        .insertInto("users")
        .values({ email: `owner-${suffix}@example.org`, displayName: "Olive" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    baseId = (await insertBase(db, owner, { name: "Sales" })).id;
    clients = (
      await insertTable(db, owner, {
        baseId,
        name: "Clients",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    await write(clients, [
      { name: "Alpha invoice" },
      { name: "Beta note" },
      { name: "Gamma invoice" },
    ]);
    flags = (
      await insertTable(db, owner, {
        baseId,
        name: "Flags",
        columns: [{ name: "done", label: "Done", fieldType: "boolean" }],
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
    await rm(folder, { recursive: true, force: true });
  });

  it("holds the rows the search finds, and no other", async () => {
    const { rows, text } = await exported(clients, "invoice");
    expect(rows).toBe(2);
    expect(text).toContain("Alpha invoice");
    expect(text).toContain("Gamma invoice");
    expect(text).not.toContain("Beta note");
  });

  it("makes a file of no row when nothing is found", async () => {
    expect((await exported(clients, "nowhere")).rows).toBe(0);
  });

  it("counts what the search finds against the ceiling, not the table", async () => {
    expect((await exported(clients, "Beta", 1)).rows).toBe(1);
    await expect(exported(clients, "invoice", 1)).rejects.toMatchObject({
      code: "export_too_large",
    });
  });

  it("refuses every format when the view leaves no field to read", async () => {
    const { id: viewId } = await db
      .insertInto("views")
      .values({
        tableId: clients,
        name: "Nothing",
        viewType: "grid",
        ownerId: owner,
        config: JSON.stringify({ hiddenFields: ["name"] }),
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const format of ["csv", "json", "xlsx"] as const) {
      const path = join(folder, `${randomBytes(4).toString("hex")}.${format}`);
      await expect(
        exportTable(
          { db },
          { userId: owner, bindings: await loadBindings(db, owner) },
          await table(clients),
          { format, viewId },
          { path, maxRows: 100 },
        ),
      ).rejects.toMatchObject({ code: "export_no_columns" });
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("takes a search on a table with no field to search", async () => {
    expect((await exported(flags, "anything")).rows).toBe(0);
  });
});
