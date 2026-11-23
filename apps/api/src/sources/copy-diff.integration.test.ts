/**
 * The comparison of a table's two copies, run on PostgreSQL: it must hold
 * for any number of columns, and find only what differs.
 */
import { randomUUID } from "node:crypto";
import { buildCopyDiff, copyTable, SYNC_SCHEMA } from "@anygriddb/core";
import { runStatement, type Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";

describe("comparing two copies of a wide table", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const created = await createTestDatabase("copy_diff");
    db = created.db;
    close = created.close;
  });

  afterAll(async () => {
    await close?.();
  });

  /** Two copies of one row, the second with `change` applied, and the diff. */
  async function diff(count: number, change?: { column: number }) {
    const tableId = randomUUID();
    const names = Array.from(
      { length: count },
      (_, index) => `c${String(index)}`,
    );
    const columns = names.map((name) => `"${name}" text`).join(", ");
    const values = names.map(() => "'same'").join(", ");
    for (const next of [false, true]) {
      const table = `"${SYNC_SCHEMA}"."${copyTable(tableId, next)}"`;
      await sql
        .raw(`create table ${table} ("ag_id" text primary key, ${columns})`)
        .execute(db);
      await sql.raw(`insert into ${table} values ('1', ${values})`).execute(db);
    }
    if (change) {
      await sql
        .raw(
          `update "${SYNC_SCHEMA}"."${copyTable(tableId, true)}" set "c${String(change.column)}" = 'other'`,
        )
        .execute(db);
    }
    return runStatement(db, buildCopyDiff(tableId, names, 201));
  }

  it.each([49, 50, 51, 300])(
    "announces no row when %i columns are the same",
    async (count) => {
      expect(await diff(count)).toEqual([]);
    },
  );

  it.each([
    [49, 48],
    [50, 49],
    [300, 0],
    [300, 40],
    [300, 299],
  ])("finds a change among %i columns, in column %i", async (count, column) => {
    expect(await diff(count, { column })).toMatchObject([
      { id: "1", op: "update" },
    ]);
  });
});
