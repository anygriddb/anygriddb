/**
 * A chain of formulas, each reading the one before, against a real
 * database: fifteen levels are computed, and the sixteenth is refused when
 * it is saved, with its reason, instead of being kept and reading blank.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { loadEngine } from "./engine.js";
import { readPage } from "./rows.js";
import { addColumn, insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");

describe("a chain of formulas", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let ownerId = "";
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("formula_chain");
    db = created.db;
    close = created.close;
    const owner = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.org`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = owner.id;
    const base = await insertBase(db, ownerId, { name: `Chain ${suffix}` });
    tableId = (
      await insertTable(db, ownerId, {
        baseId: base.id,
        name: "Steps",
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "start", label: "Start", fieldType: "number" },
        ],
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  const add = (level: number) =>
    addColumn(db, ownerId, tableId, {
      name: `f${String(level)}`,
      label: `F${String(level)}`,
      fieldType: "formula",
      formulaSource:
        level === 1 ? "{Start} + 1" : `{F${String(level - 1)}} + 1`,
    });

  it("keeps fifteen levels and refuses the sixteenth, with its reason", async () => {
    for (let level = 1; level <= 15; level += 1) {
      await add(level);
    }
    await expect(add(16)).rejects.toMatchObject({ code: "formula_too_large" });
    // Nothing of the refused field was kept, and the table reads.
    const { engine } = await loadEngine(db, tableId, () => true);
    expect(engine.table.columns.map((column) => column.name)).not.toContain(
      "f16",
    );
    const page = await readPage(db, engine, { limit: 5 }, { total: true });
    expect([page.rows, page.total]).toEqual([[], 0]);
  });
});
