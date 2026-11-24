/**
 * The order of a row's history when writes overlap, against a real
 * database: what the row holds now is what its history shows first.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { buildCreateTable, buildInsert } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { runRows, withAudit } from "./audit-context.js";
import { readAudit } from "./rows.js";

const columns = [{ name: "title", fieldType: "text" as const, config: {} }];

describe("the order of a row's history", () => {
  const table = `t_${randomBytes(8).toString("hex")}`;
  const tableId = randomUUID();
  let database: Database;
  let pool: pg.Pool;
  let ownerPool: pg.Pool;
  let close: (() => Promise<void>) | undefined;
  let userId = "";

  const newRow = async (title: string) => {
    const inserted = await withAudit(database, { userId, tableId }, (tx) =>
      runRows(tx, buildInsert({ table, columns, values: { title } })),
    );
    return String(inserted[0]?.id);
  };
  const begin = async (client: pg.PoolClient) => {
    await client.query("begin");
    await client.query(
      `select set_config('anygrid.user_id', $1, true),
              set_config('anygrid.table_id', $2, true)`,
      [userId, tableId],
    );
  };
  const write = (client: pg.PoolClient, rowId: string, title: string) =>
    client.query(`update "${table}" set "title" = $1 where id = $2`, [
      title,
      rowId,
    ]);
  const titles = async (rowId: string) =>
    (await readAudit(database, tableId, rowId)).map(
      (event) => (event.newValue as { title?: string } | null)?.title,
    );

  beforeAll(async () => {
    const created = await createTestDatabase("audit_order");
    database = created.db;
    pool = created.pool;
    ownerPool = created.owner.pool;
    close = created.close;
    for (const statement of buildCreateTable({ table, columns })) {
      await pool.query(statement.text, [...statement.values]);
    }
    userId = (
      await database
        .insertInto("users")
        .values({
          email: `order-${randomBytes(4).toString("hex")}@example.org`,
          displayName: "Olive Order",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  });

  afterAll(async () => {
    await close?.();
  });

  it("shows the last write first, from a transaction begun before the other", async () => {
    const rowId = await newRow("first");
    const early = await pool.connect();
    const late = await pool.connect();
    try {
      await begin(early);
      await begin(late);
      await write(late, rowId, "second");
      await late.query("commit");
      await write(early, rowId, "third");
      await early.query("commit");
    } finally {
      early.release();
      late.release();
    }

    const held = await pool.query<{ title: string }>(
      `select "title" from "${table}" where id = $1`,
      [rowId],
    );
    expect(held.rows[0]?.title).toBe("third");
    expect(await titles(rowId)).toEqual(["third", "second", "first"]);
  });

  it("keeps events older than the order behind the new ones, by their date", async () => {
    const rowId = await newRow("kept");
    // Only the trail's owner can still write an event with no order: the
    // events from before it, as a restore brings them back (ADR 0121).
    await ownerPool.query(
      `insert into audit_events
         (user_id, action, table_id, record_id, new_value, occurred_at, write_order)
       values
         ($1, 'update', $2, $3, '{"title":"older"}', now() - interval '2 days', null),
         ($1, 'update', $2, $3, '{"title":"old"}', now() - interval '1 day', null)`,
      [userId, tableId, rowId],
    );

    expect(await titles(rowId)).toEqual(["kept", "old", "older"]);
  });
});
