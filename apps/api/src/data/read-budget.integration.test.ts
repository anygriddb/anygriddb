/**
 * A page read under what a request may hold, on a migrated database: the
 * same rows in the same order when it fits, and a clean refusal when it
 * does not, with the connection left usable.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReadBudget, ReadMemory } from "../read-budget.js";
import { createTestDatabase } from "../test-database.js";
import { loadEngine } from "./engine.js";
import { insertRows, readAudit, readByIds, readPage } from "./rows.js";
import { insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");
const ROWS = 40;
const CELL = 10_000;

describe("a page read under a budget", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let tableId = "";

  const engine = async () => (await loadEngine(db, tableId, () => true)).engine;
  const spec = {
    limit: ROWS,
    sort: [{ column: "n", direction: "desc" as const }],
  };
  const budget = (limit: number, capacity = limit) =>
    new ReadBudget(new ReadMemory(capacity), limit);

  beforeAll(async () => {
    const created = await createTestDatabase("read_budget");
    db = created.db;
    close = created.close;
    const owner = (
      await db
        .insertInto("users")
        .values({ email: `o-${suffix}@example.org`, displayName: "O" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const baseId = (await insertBase(db, owner, { name: "B" })).id;
    tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "Wide",
        columns: [
          { name: "n", label: "N", fieldType: "number" },
          { name: "body", label: "Body", fieldType: "long_text" },
        ],
      })
    ).id;
    const { engine: loaded, rows } = await loadEngine(db, tableId, () => true);
    const physical = rows.tables.find((table) => table.id === tableId);
    if (!physical) throw new Error("no table");
    await insertRows(
      db,
      loaded,
      {
        userId: owner,
        tableId,
        physicalName: physical.physicalName,
        baseId,
        reason: null,
        source: "test",
      },
      Array.from({ length: ROWS }, (_, index) => ({
        n: String(index),
        body: "x".repeat(CELL),
      })),
    );
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("gives the same rows, in the same order, when the page fits", async () => {
    const read = await engine();
    const plain = await readPage(db, read, spec, { total: true });
    const held = await readPage(db, read, spec, {
      total: true,
      budget: budget(10 * ROWS * CELL),
    });
    expect(held.rows).toEqual(plain.rows);
    expect(held.total).toBe(ROWS);
    expect(held.rows.map((row) => row.n)[0]).toBe(String(ROWS - 1));
  });

  it("refuses a page past what the request may hold", async () => {
    await expect(
      readPage(db, await engine(), spec, {
        total: false,
        budget: budget(5 * CELL),
      }),
    ).rejects.toMatchObject({ code: "page_too_large" });
  });

  it("counts every read of one request together", async () => {
    const shared = budget(ROWS * CELL + (ROWS * CELL) / 2);
    const read = await engine();
    await readPage(db, read, spec, { total: false, budget: shared });
    await expect(
      readPage(db, read, spec, { total: false, budget: shared }),
    ).rejects.toMatchObject({ code: "page_too_large" });
  });

  it("says the instance is busy when the process holds too much", async () => {
    await expect(
      readPage(db, await engine(), spec, {
        total: false,
        budget: budget(10 * ROWS * CELL, 5 * CELL),
      }),
    ).rejects.toMatchObject({ code: "reads_busy" });
  });

  it("reads a row's history whole when it fits, and refuses past it", async () => {
    const read = await engine();
    const [row] = (await readPage(db, read, spec, { total: false })).rows;
    const id = row?.id ?? "";
    const plain = await readAudit(db, tableId, id);
    expect(plain.length).toBeGreaterThan(0);
    await expect(
      readAudit(db, tableId, id, () => false, budget(10 * CELL)),
    ).resolves.toEqual(plain);
    await expect(
      readAudit(db, tableId, id, () => false, budget(CELL / 2)),
    ).rejects.toMatchObject({ code: "page_too_large" });
  });

  it("counts rows read by id against the same budget", async () => {
    const read = await engine();
    const ids = (await readPage(db, read, spec, { total: false })).rows.map(
      (row) => row.id,
    );
    await expect(
      readByIds(db, read, ids, "UTC", undefined, budget(5 * CELL)),
    ).rejects.toMatchObject({ code: "page_too_large" });
    await expect(
      readByIds(db, read, ids, "UTC", undefined, budget(10 * ROWS * CELL)),
    ).resolves.toHaveLength(ROWS);
  });

  it("weighs a page of control characters as it is written out", async () => {
    const owner = await db
      .selectFrom("users")
      .select("id")
      .executeTakeFirstOrThrow();
    const { engine: loaded, rows } = await loadEngine(db, tableId, () => true);
    const physical = rows.tables.find((table) => table.id === tableId);
    if (!physical) throw new Error("no table");
    const [id] = await insertRows(
      db,
      loaded,
      {
        userId: owner.id,
        tableId,
        physicalName: physical.physicalName,
        baseId: physical.baseId,
        reason: null,
        source: "test",
      },
      [{ n: "-1", body: "\u0001".repeat(CELL) }],
    );
    await expect(
      readByIds(db, loaded, [id ?? ""], "UTC", undefined, budget(3 * CELL)),
    ).rejects.toMatchObject({ code: "page_too_large" });
  });

  it("leaves its connection usable after a refusal", async () => {
    const read = await engine();
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await expect(
        readPage(db, read, spec, { total: false, budget: budget(CELL) }),
      ).rejects.toMatchObject({ code: "page_too_large" });
    }
    const after = await readPage(db, read, spec, { total: true });
    expect(after.rows).toHaveLength(ROWS);
  });
});
