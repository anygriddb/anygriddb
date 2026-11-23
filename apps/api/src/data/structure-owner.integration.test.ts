/**
 * The owner's functions that change a table's structure, against a real
 * database, called by a real role that owns nothing: what they refuse,
 * and that they name and type things as the application does.
 */
import { randomBytes } from "node:crypto";
import {
  buildCreateTable,
  buildInsert,
  indexName,
  physicalSqlType,
  WRITABLE_TYPES,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { runRows, withAudit } from "./audit-context.js";

const role = `ag_runtime_${randomBytes(5).toString("hex")}`;
const password = randomBytes(18).toString("hex");
const table = `t_${randomBytes(16).toString("hex")}`;
const columns = [{ name: "amount", fieldType: "number" as const, config: {} }];

describe("the owner's functions on a table's structure", () => {
  let db: Database;
  let owner: pg.Pool;
  let close: (() => Promise<void>) | undefined;
  let session: pg.Client;
  let userId = "";
  let rowId = "";

  const functions = async () =>
    (
      await owner.query<{ signature: string }>(
        `select p.oid::regprocedure::text as signature
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prosecdef
            and p.proname not in ('ag_purge_audit_events', 'ag_erase_account')`,
      )
    ).rows.map((row) => row.signature);

  beforeAll(async () => {
    const created = await createTestDatabase("structure_owner");
    db = created.db;
    owner = created.owner.pool;
    close = created.close;
    await owner.query(`create role "${role}" login password '${password}'`);
    await owner.query(`grant usage on schema public to "${role}"`);
    for (const signature of await functions()) {
      await owner.query(`grant execute on function ${signature} to "${role}"`);
    }
    const [create] = buildCreateTable({ table, columns });
    if (!create) throw new Error("no statement");
    await owner.query(create.text, [...create.values]);
    await owner.query(
      `grant select, insert, update, delete on "${table}" to "${role}"`,
    );
    userId = (
      await db
        .insertInto("users")
        .values({
          email: `owner-${randomBytes(4).toString("hex")}@example.org`,
          displayName: "Sam Structure",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const inserted = await withAudit(db, { userId, tableId: userId }, (tx) =>
      runRows(tx, buildInsert({ table, columns, values: { amount: "10" } })),
    );
    rowId = String(inserted[0]?.id);
    const url = new URL(created.url);
    url.username = role;
    url.password = password;
    session = new pg.Client({ connectionString: url.toString() });
    await session.connect();
  });

  afterAll(async () => {
    await session.end();
    await owner.query(`drop owned by "${role}"`);
    await owner.query(`drop role "${role}"`);
    await close?.();
  });

  it("types and names as the application does", async () => {
    for (const fieldType of WRITABLE_TYPES) {
      const { rows } = await owner.query<{ sql: string }>(
        "select ag_field_sql_type($1) as sql",
        [fieldType],
      );
      expect(rows[0]?.sql).toBe(physicalSqlType(fieldType));
    }
    for (const column of ["amount", "ag_seq", "a_much_longer_name_9"]) {
      for (const kind of ["uq", "ix", "gin"] as const) {
        const { rows } = await owner.query<{ name: string }>(
          "select ag_index_name($1, $2, $3) as name",
          [table, column, kind],
        );
        expect(rows[0]?.name).toBe(indexName(table, column, kind));
      }
    }
  });

  it("changes a table of rows for a role that owns nothing", async () => {
    await session.query("select ag_add_column($1, 'note', 'text', 'it''s')", [
      table,
    ]);
    const { rows } = await owner.query<{ note: string }>(
      `select note from "${table}" where id = $1`,
      [rowId],
    );
    expect(rows[0]?.note).toBe("it's");
    await session.query("select ag_drop_column($1, 'note')", [table]);
  });

  it.each([
    ["the trail", "select ag_drop_table('audit_events')"],
    ["the accounts", "select ag_add_column('users', 'x', 'text', null)"],
    [
      "a name that is a statement",
      `select ag_drop_table('t_x"; drop table users; --')`,
    ],
    ["a system column", `select ag_drop_column('${table}', 'ag_status')`],
    ["the rows' id", `select ag_drop_column('${table}', 'id')`],
    [
      "a column that is a statement",
      `select ag_drop_column('${table}', 'x" cascade; --')`,
    ],
    [
      "a type that is a statement",
      `select ag_add_column('${table}', 'x', 'text; drop table users', null)`,
    ],
    [
      "a job that is a statement",
      `select ag_conversion_guard('${table}', '1''); drop table users; --')`,
    ],
  ])("refuses %s", async (_what, statement) => {
    await expect(session.query(statement)).rejects.toThrow(/^Invalid /);
    const { rows } = await owner.query<{ there: string | null }>(
      "select to_regclass('public.users')::text as there",
    );
    expect(rows[0]?.there).toBe("users");
  });

  it.each([
    ["disable its triggers", `alter table "${table}" disable trigger user`],
    [
      "rewrite a column",
      `alter table "${table}" alter column amount type numeric using 31337`,
    ],
    ["drop its audit trigger", `drop trigger audit_record on "${table}"`],
    ["drop it", `drop table "${table}"`],
  ])(
    "leaves a role that owns nothing unable to %s",
    async (_what, statement) => {
      await expect(session.query(statement)).rejects.toThrow(/must be owner/);
      const { rows } = await owner.query<{ amount: string }>(
        `select amount from "${table}" where id = $1`,
        [rowId],
      );
      expect(Number(rows[0]?.amount)).toBe(10);
    },
  );
});
