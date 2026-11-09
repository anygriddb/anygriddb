import { randomBytes } from "node:crypto";
import {
  buildCreateTable,
  buildInsert,
  buildReadRows,
  buildSetStatus,
  buildUpdate,
  type EngineCatalog,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { runRows, withAudit } from "./audit-context.js";

const columns = [{ name: "title", fieldType: "text" as const, config: {} }];

describe("audit triggers", () => {
  const table = `t_${randomBytes(8).toString("hex")}`;
  let database: Database;
  let pool: pg.Pool;
  let close: (() => Promise<void>) | undefined;
  const query = async <Row extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<Row[]> => (await pool.query<Row>(text, values)).rows;

  beforeAll(async () => {
    const created = await createTestDatabase("audit");
    database = created.db;
    pool = created.pool;
    close = created.close;

    const migrated = await query<{ ready: string | null }>(
      `select to_regclass('public.audit_events')::text as ready`,
    );
    expect(migrated[0]?.ready).toBe("audit_events");

    for (const statement of buildCreateTable({ table, columns })) {
      await query(statement.text);
    }
  });

  afterAll(async () => {
    await close?.();
  });

  it("rejects a write without audit context and a tampered audit row", async () => {
    await expect(
      query(`insert into "${table}" ("title") values ('nope')`),
    ).rejects.toThrow(/Audit context required/);

    const insertedUser = await database
      .insertInto("users")
      .values({
        email: `audit-${randomBytes(4).toString("hex")}@example.com`,
        displayName: "Audit",
      })
      .returning("id")
      .executeTakeFirst();
    const userId = insertedUser?.id;
    expect(userId).toBeTruthy();
    if (!userId) {
      return;
    }

    const inserted = await withAudit(
      database,
      { userId, tableId: userId },
      (tx) =>
        runRows(
          tx,
          buildInsert({
            table,
            columns,
            values: { title: "cell" },
          }),
        ),
    );
    const rowId = inserted[0]?.id;
    expect(rowId).toEqual(expect.any(String));
    if (typeof rowId !== "string") {
      return;
    }

    const engine: EngineCatalog = {
      table: {
        id: userId,
        storage: "native",
        physicalName: table,
        primaryColumn: "title",
        columns: [
          {
            id: "c1",
            name: "title",
            label: "Title",
            fieldType: "text",
            config: {},
          },
        ],
      },
      tables: new Map(),
      readable: () => true,
    };
    const statement = buildReadRows(engine, { limit: 10 });
    const read = await query(statement.text, statement.values);
    expect(read[0]?.title).toBe("cell");
    expect(read[0]?.ag_created_by).toBe(userId);

    await withAudit(
      database,
      { userId, tableId: userId, source: "web" },
      (tx) =>
        runRows(
          tx,
          buildUpdate({
            table,
            columns,
            id: rowId,
            values: { title: "edited" },
          }),
        ),
    );
    await withAudit(
      database,
      { userId, tableId: userId, action: "submit" },
      (tx) =>
        runRows(tx, buildSetStatus({ table, id: rowId, status: "submitted" })),
    );
    await withAudit(
      database,
      { userId, tableId: userId, action: "lock" },
      (tx) =>
        runRows(tx, buildSetStatus({ table, id: rowId, status: "locked" })),
    );
    await expect(
      withAudit(database, { userId, tableId: userId }, (tx) =>
        runRows(
          tx,
          buildUpdate({ table, columns, id: rowId, values: { title: "late" } }),
        ),
      ),
    ).rejects.toThrow("Row locked");
    const sources = await query<{ action: string; source: string | null }>(
      `select action::text as action, source from audit_events
       where record_id = $1::uuid order by occurred_at`,
      [rowId],
    );
    expect(sources.map((event) => event.action)).toEqual([
      "insert",
      "update",
      "submit",
      "lock",
    ]);
    expect(sources[1]?.source).toBe("web");

    const events = await query<{ id: string }>(
      `select id from audit_events
       where record_id = $1::uuid and action = 'insert'`,
      [rowId],
    );
    const eventId = events[0]?.id;
    expect(eventId).toBeTruthy();
    if (!eventId) {
      return;
    }

    await expect(
      query(`update audit_events set reason = 'tamper' where id = $1::uuid`, [
        eventId,
      ]),
    ).rejects.toThrow(/Audit immutable/);
    await expect(
      query(`delete from audit_events where id = $1::uuid`, [eventId]),
    ).rejects.toThrow(/Audit immutable/);
  });
});
