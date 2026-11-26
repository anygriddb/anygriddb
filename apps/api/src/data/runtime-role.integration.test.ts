/**
 * What the role the application signs in as cannot do to what it keeps
 * (ADR 0119), whatever a statement reaching the database asks: the attacks
 * on the trail, played as that role, on a real database.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  buildCreateTable,
  buildInsert,
  type CircuitDefinition,
  definitionOf,
} from "@anygriddb/core";
import { grantRuntimeRole, type Database } from "@anygriddb/db";
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, RUNTIME_ROLE } from "../test-database.js";
import { runRows, withAudit } from "./audit-context.js";
import { listCircuitTemplates } from "./status-circuits.js";

const table = `t_${randomBytes(16).toString("hex")}`;
const columns = [{ name: "amount", fieldType: "number" as const, config: {} }];
const TRAILS = [
  ["audit_events", "id"],
  ["row_signatures", "id"],
  ["external_writes", "id"],
  ["external_write_steps", "write_id"],
  ["external_status_events", "id"],
] as const;

describe("the role the application signs in as", () => {
  let db: Database;
  let pool: pg.Pool;
  let ownerPool: pg.Pool;
  let close: (() => Promise<void>) | undefined;
  let userId = "";
  let rowId = "";
  const tableId = randomUUID();

  const inTransaction = async (...statements: string[]) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const statement of statements) await client.query(statement);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  };
  const held = async () => {
    const { rows } = await ownerPool.query<{ amount: string; status: string }>(
      `select amount::text as amount, ag_status as status from "${table}" where id = $1`,
      [rowId],
    );
    return rows[0];
  };

  beforeAll(async () => {
    const created = await createTestDatabase("runtime_role");
    db = created.db;
    pool = created.pool;
    ownerPool = created.owner.pool;
    close = created.close;
    for (const statement of buildCreateTable({ table, columns })) {
      await pool.query(statement.text, [...statement.values]);
    }
    userId = (
      await db
        .insertInto("users")
        .values({
          email: `runtime-${randomBytes(4).toString("hex")}@example.org`,
          displayName: "Rae Runtime",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const inserted = await withAudit(db, { userId, tableId }, (tx) =>
      runRows(tx, buildInsert({ table, columns, values: { amount: "10" } })),
    );
    rowId = String(inserted[0]?.id);
    for (const action of ["submit", "lock", "sign"] as const) {
      const status = { submit: "submitted", lock: "locked", sign: "signed" };
      await withAudit(db, { userId, tableId, action }, (tx) =>
        tx.executeQuery({
          sql: `update "${table}" set ag_status = $1 where id = $2`,
          parameters: [status[action], rowId],
          query: { kind: "RawNode" } as never,
          queryId: { queryId: randomUUID() },
        }),
      );
    }
  });

  afterAll(async () => {
    await close?.();
  });

  it("owns nothing it keeps", async () => {
    const { rows } = await pool.query<{ owned: number }>(
      `select count(*)::int as owned from pg_class c
        where pg_has_role(current_user, c.relowner, 'MEMBER')
          and c.relnamespace = 'public'::regnamespace`,
    );
    expect(rows[0]?.owned).toBe(0);
  });

  it.each(TRAILS)("cannot rewrite or empty %s", async (trail, column) => {
    for (const statement of [
      `update ${trail} set ${column} = ${column}`,
      `delete from ${trail}`,
      `truncate ${trail}`,
    ]) {
      await expect(pool.query(statement)).rejects.toThrow(/permission denied/);
    }
    await expect(
      pool.query(`alter table ${trail} disable trigger user`),
    ).rejects.toThrow(/must be owner/);
  });

  it("cannot choose an event's place in the trail, or leave it without one", async () => {
    // Placed below what the collectors already have, or with no order at
    // all, an event would never leave for them (ADR 0121).
    const { rows: before } = await ownerPool.query<{ top: string }>(
      "select coalesce(max(write_order), 0)::text as top from audit_events",
    );
    const { rows } = await pool.query<{
      order: string | null;
      xact: string;
      own: string;
    }>(
      `insert into audit_events (user_id, action, write_order, xact_id)
       values ($1, 'update', 1, '1'::xid8), ($1, 'update', null, null)
       returning write_order::text as "order", xact_id::text as xact,
                 pg_current_xact_id()::text as own`,
      [userId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(BigInt(row.order ?? "0")).toBeGreaterThan(
        BigInt(before[0]?.top ?? "0"),
      );
      expect(row.xact).toBe(row.own);
    }
  });

  it("does not get past the trail with the flags that open it", async () => {
    await expect(
      inTransaction(
        "select set_config('anygrid.purge_audit', 'on', true)",
        "delete from audit_events",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inTransaction(
        "select set_config('anygrid.anonymize', 'on', true)",
        "update audit_events set user_id = user_id",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inTransaction(
        "select set_config('anygrid.migrate', 'on', true)",
        "insert into bases (name) values ('Hidden')",
      ),
    ).rejects.toThrow(/Audit context required/);
  });

  // The trigger takes its rules from the table's status circuit (ADR
  // 0124): rules the role could rewrite would let it unseal a signed row.
  describe("its table's status circuit", () => {
    const context = (action = "") =>
      `select set_config('anygrid.user_id', '${userId}', true),
              set_config('anygrid.table_id', '${tableId}', true),
              set_config('anygrid.action', '${action}', true)`;
    /**
     * Saves a template's circuit on the table, as its editor does, changed
     * first if asked: the one way the role has to change a circuit.
     */
    const replace = async (
      template: string,
      remap: Record<string, string>,
      change: (circuit: CircuitDefinition) => void = () => undefined,
    ) => {
      const shipped = (await listCircuitTemplates(db)).find(
        (circuit) => circuit.key === template,
      );
      if (!shipped) throw new Error(`no template ${template}`);
      const circuit = definitionOf(shipped);
      change(circuit);
      return withAudit(db, { userId, tableId }, (tx) =>
        sql`select ag_save_status_circuit(
              ${tableId}::uuid,
              ${JSON.stringify(circuit)}::jsonb,
              ${JSON.stringify(remap)}::jsonb
            )`.execute(tx),
      );
    };
    const circuitEvents = async () =>
      (
        await ownerPool.query<{ n: number }>(
          `select count(*)::int as n from audit_events
            where catalog_table = 'status_circuits' and table_id = $1`,
          [tableId],
        )
      ).rows[0]?.n;

    beforeAll(async () => {
      await withAudit(db, { userId }, async (tx) => {
        const base = await tx
          .insertInto("bases")
          .values({ name: "Circuits" })
          .returning("id")
          .executeTakeFirstOrThrow();
        await tx
          .insertInto("dataTables")
          .values({
            id: tableId,
            baseId: base.id,
            name: "Ledger",
            physicalName: table,
          })
          .execute();
      });
    });

    it.each([
      "update status_states set row_writable = true, seal = false",
      "delete from status_transitions",
      "delete from status_circuits",
      `insert into status_transition_grants (transition_id, role_key)
         select id, 'viewer' from status_transitions`,
      "truncate status_states cascade",
    ])("cannot rewrite them: %s", async (statement) => {
      await expect(pool.query(statement)).rejects.toThrow(/permission denied/);
      expect(await held()).toEqual({ amount: "10", status: "signed" });
    });

    it("cannot move a signed row by calling it a circuit's remap", async () => {
      await expect(
        inTransaction(
          context("remap"),
          `update "${table}" set ag_status = 'draft' where id = '${rowId}'`,
        ),
      ).rejects.toThrow(/Invalid status|Row locked/);
      expect(await held()).toEqual({ amount: "10", status: "signed" });
    });

    it("cannot free a signed row with a circuit whose signed state writes", async () => {
      const before = await circuitEvents();
      await expect(
        replace("compliance", {}, (circuit) => {
          for (const state of circuit.states) {
            if (state.key === "signed") {
              state.seal = false;
              state.writable = true;
              state.delete = true;
            }
          }
        }),
      ).rejects.toThrow(/Row locked/);
      expect(await held()).toEqual({ amount: "10", status: "signed" });
      expect(await circuitEvents()).toBe(before);
    });

    it.each([
      ["a circuit with no sealed state of that name", "simple_review", {}],
      ["a remap away from it", "compliance", { signed: "draft" }],
      [
        "a remap to a sealed state elsewhere",
        "simple_review",
        { signed: "approved" },
      ],
    ])(
      "cannot free a signed row with %s",
      async (_what, template, remap: Record<string, string>) => {
        const before = await circuitEvents();
        await expect(replace(template, remap)).rejects.toThrow(/Row locked/);
        expect(await held()).toEqual({ amount: "10", status: "signed" });
        expect(await circuitEvents()).toBe(before);
      },
    );

    it("changes it through the owner only, and the change is on the trail", async () => {
      const before = await circuitEvents();
      await replace("compliance", {});
      expect(await circuitEvents()).toBe((before ?? 0) + 1);
      expect(await held()).toEqual({ amount: "10", status: "signed" });
    });
  });

  it.each([
    ["disable its triggers", `alter table "${table}" disable trigger user`],
    [
      "rewrite it with no trigger",
      `alter table "${table}" alter column amount type numeric using 31337`,
    ],
    ["drop its trail's trigger", `drop trigger audit_record on "${table}"`],
    ["empty it", `truncate "${table}"`],
    ["drop it", `drop table "${table}"`],
  ])("cannot %s, and a signed row stays as it is", async (_what, statement) => {
    await expect(pool.query(statement)).rejects.toThrow(
      /must be owner|permission denied/,
    );
    expect(await held()).toEqual({ amount: "10", status: "signed" });
  });

  it("keeps the copies of clients' tables in their own schema", async () => {
    const ownerOf = async (name: string) =>
      (
        await ownerPool.query<{ owner: string }>(
          `select tableowner as owner from pg_tables
            where schemaname = 'ag_sync' and tablename = $1`,
          [name],
        )
      ).rows[0]?.owner;
    const made = `c_${randomBytes(8).toString("hex")}`;
    await pool.query(`create table ag_sync."${made}" (id int)`);
    expect(await ownerOf(made)).toBe(RUNTIME_ROLE);
    await pool.query(`drop table ag_sync."${made}"`);
    expect(await ownerOf(made)).toBeUndefined();

    // A copy made while the application signed in as the owner comes to it.
    const earlier = `c_${randomBytes(8).toString("hex")}`;
    await ownerPool.query(`create table ag_sync."${earlier}" (id int)`);
    expect(await ownerOf(earlier)).not.toBe(RUNTIME_ROLE);
    await grantRuntimeRole(ownerPool, RUNTIME_ROLE);
    expect(await ownerOf(earlier)).toBe(RUNTIME_ROLE);
    await pool.query(`drop table ag_sync."${earlier}"`);
    expect(await ownerOf(earlier)).toBeUndefined();
  });

  it("cannot change a signed row by writing to it", async () => {
    await expect(
      inTransaction(
        `select set_config('anygrid.user_id', '${userId}', true)`,
        `select set_config('anygrid.table_id', '${tableId}', true)`,
        `update "${table}" set amount = 31337 where id = '${rowId}'`,
      ),
    ).rejects.toThrow(/Row locked/);
    expect(await held()).toEqual({ amount: "10", status: "signed" });
  });

  it.each([
    [
      "move the trail's order",
      "select setval('audit_events_write_order_seq', 1)",
    ],
    ["move a table's places", "select setval('ag_row_position', 1)"],
    ["forge the migrations' record", "delete from schema_migrations"],
    ["make a table of its own", "create table planted (id int)"],
    [
      "replace a function",
      "create or replace function ag_stamp() returns trigger language plpgsql as $$ begin return new; end $$",
    ],
  ])("cannot %s", async (_what, statement) => {
    await expect(pool.query(statement)).rejects.toThrow(
      /permission denied|must be owner/,
    );
  });

  describe("through the functions of the tables' owner", () => {
    const within = async <T>(work: (client: pg.PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        return await work(client);
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    };
    const oldEvent = (client: pg.PoolClient) =>
      client.query(
        `insert into audit_events (user_id, action, occurred_at)
         values ($1, 'update', now() - interval '800 days')`,
        [userId],
      );

    it("cannot empty a signed value by converting its field", async () => {
      await expect(
        inTransaction(
          `select ag_conversion_add_column('${table}', 'amount', 'number')`,
          `select ag_conversion_switch('${table}', 'amount')`,
        ),
      ).rejects.toThrow(/Row locked/);
      expect(await held()).toEqual({ amount: "10", status: "signed" });
    });

    it("cannot drop a field a signed row holds a value in", async () => {
      await expect(
        inTransaction(`select ag_drop_column('${table}', 'amount')`),
      ).rejects.toThrow(/Row locked/);
      expect(await held()).toEqual({ amount: "10", status: "signed" });
    });

    it("drops a field no signed row holds a value in", async () => {
      await within(async (client) => {
        const later = async () => {
          const { rows } = await client.query(
            `select 1 from pg_attribute
              where attrelid = $1::text::regclass
                and attname = 'later' and not attisdropped`,
            [table],
          );
          return rows.length;
        };
        await client.query(
          `select ag_add_column('${table}', 'later', 'text', null)`,
        );
        expect(await later()).toBe(1);
        await client.query(`select ag_drop_column('${table}', 'later')`);
        expect(await later()).toBe(0);
      });
    });

    it("leaves an event when a table holding a signed row is dropped", async () => {
      await within(async (client) => {
        await client.query(`select ag_drop_table('${table}')`);
        const { rows } = await client.query<{ rows: string }>(
          `select new_value #>> '{dropped,lockedOrSignedRows}' as rows
             from audit_events
            where action = 'catalog' and catalog_table = 'structure'
              and new_value #>> '{dropped,table}' = $1`,
          [table],
        );
        expect(rows).toEqual([{ rows: "1" }]);
      });
    });

    it("purges nothing of a trail the instance keeps for ever", async () => {
      await within(async (client) => {
        await oldEvent(client);
        const { rows } = await client.query<{ gone: number }>(
          "select ag_purge_audit_events(365, now(), 10) as gone",
        );
        expect(rows[0]?.gone).toBe(0);
      });
    });

    it("says what a purge took, called by whoever", async () => {
      await within(async (client) => {
        await client.query(
          `insert into instance_settings (key, value, updated_by)
           values ('auditRetentionDays', '365', $1)
           on conflict (key) do update set value = excluded.value`,
          [userId],
        );
        await oldEvent(client);
        const { rows } = await client.query<{ gone: number }>(
          "select ag_purge_audit_events(365, now(), 10) as gone",
        );
        expect(rows[0]?.gone).toBeGreaterThan(0);
        const said = await client.query<{ events: number }>(
          `select (new_value ->> 'events')::int as events
             from audit_events where action = 'purge' and source = 'retention'`,
        );
        expect(said.rows).toEqual([{ events: rows[0]?.gone }]);
      });
    });

    it("leaves an event when it erases an account", async () => {
      await within(async (client) => {
        const made = await client.query<{ id: string }>(
          `insert into users (email, display_name)
           values ($1, 'Erin Erased') returning id`,
          [`erased-${randomBytes(4).toString("hex")}@example.org`],
        );
        const count = async () =>
          (
            await client.query<{ events: number }>(
              `select count(*)::int as events from auth_events
                where action = 'account_erased'`,
            )
          ).rows[0]?.events;
        const before = await count();
        await client.query("select ag_erase_account($1::uuid)", [
          made.rows[0]?.id,
        ]);
        expect(await count()).toBe((before ?? 0) + 1);
      });
    });
  });
});
