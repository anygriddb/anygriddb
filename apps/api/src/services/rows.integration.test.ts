import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import cookie from "@fastify/cookie";
import { indexName } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { withAudit } from "../data/audit-context.js";
import { insertComputed } from "../data/computed.js";
import { addRelation } from "../data/relations.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { gridChannel } from "../realtime/channels.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { registerRestApi } from "../rest-api.js";
import { createTestDatabase } from "../test-database.js";
import { loadBindings } from "../auth/access.js";
import { createRows, findLiveTable, loadRowScope } from "./rows.js";

const suffix = randomBytes(6).toString("hex");

describe("row writes through the REST API", () => {
  let database: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  const recorder = recordingBus();
  let token = "";
  let clientsId = "";
  let ordersId = "";
  let ownerId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("rows");
    database = created.db;
    close = created.close;

    const people = await database
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.com`, displayName: "Owner" },
        { email: `editor-${suffix}@example.com`, displayName: "Editor" },
      ])
      .returning("id")
      .execute();
    const owner = people[0]?.id ?? "";
    ownerId = owner;
    const editor = people[1]?.id ?? "";
    const baseId = (await insertBase(database, owner, { name: "Rows" })).id;
    clientsId = (
      await insertTable(database, owner, {
        baseId,
        name: "Clients",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "city", label: "City", fieldType: "text" },
          { name: "balance", label: "Balance", fieldType: "number" },
        ],
      })
    ).id;
    ordersId = (
      await insertTable(database, owner, {
        baseId,
        name: "Orders",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    await addRelation(database, owner, {
      tableId: ordersId,
      name: "client",
      label: "Client",
      kind: "one_to_many",
      targetTableId: clientsId,
      twoWay: true,
      inverseLabel: "Orders",
      inverseName: "orders",
    });
    // Orders shows each client's city: its values move when Clients changes.
    await insertComputed(
      database,
      owner,
      {
        tableId: ordersId,
        name: "client_city",
        label: "Client city",
        relation: "client",
        target: "city",
      },
      () => true,
    );
    await withAudit(database, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values([
          { userId: editor, role: "editor", scope: "base", scopeId: baseId },
          // The editor may read orders, not change them.
          { userId: editor, role: "viewer", scope: "table", scopeId: ordersId },
        ])
        .execute(),
    );
    token = (await createApiToken(database, editor, "test")).token;

    app = Fastify();
    await app.register(cookie);
    registerRestApi(app, {
      db: database,
      bus: recorder.bus,
      publicUrl: "http://localhost",
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  async function call(
    method: "POST" | "PATCH",
    tableId: string,
    payload: unknown,
  ) {
    return app.inject({
      method,
      url: `/api/v1/tables/${tableId}/records`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });
  }

  it("tells the tables that read a changed table that their values moved", async () => {
    const created = await call("POST", clientsId, {
      records: [{ fields: { name: "Acme", city: "Lyon" } }],
    });
    expect(created.statusCode).toBe(200);
    const id = created.json<{ records: Array<{ id: string }> }>().records[0]
      ?.id;
    expect(id).toBeTruthy();

    recorder.published.length = 0;
    const updated = await call("PATCH", clientsId, {
      records: [{ id, fields: { city: "Nantes" } }],
    });
    expect(updated.statusCode).toBe(200);
    expect(recorder.published).toContainEqual({
      channel: gridChannel(clientsId),
      message: {
        type: "rows",
        channel: clientsId,
        op: "update",
        rowIds: [id],
      },
    });
    expect(recorder.published).toContainEqual({
      channel: gridChannel(ordersId),
      message: { type: "stale", channel: ordersId },
    });
  });

  it("keeps every digit of an exact number, in and out", async () => {
    // 2^53 + 1, with cents: a float would round both ends.
    const exact = "9007199254740993.25";
    const created = await call("POST", clientsId, {
      records: [{ fields: { name: "Exact", balance: exact } }],
    });
    expect(created.statusCode).toBe(200);
    const id = created.json<{ records: Array<{ id: string }> }>().records[0]
      ?.id;
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/tables/${clientsId}/records/${id ?? ""}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.json<{ fields: { balance: unknown } }>().fields.balance).toBe(
      exact,
    );
    // A JSON number is still accepted, as the decimal it prints as.
    const typed = await call("PATCH", clientsId, {
      records: [{ id, fields: { balance: 12.5 } }],
    });
    expect(typed.statusCode).toBe(200);
  });

  it("refuses a link that writes a table the caller may only read", async () => {
    // Linking orders from the client side writes each order's foreign key.
    const created = await call("POST", clientsId, {
      records: [{ fields: { name: "Initech" } }],
    });
    const clientId = created.json<{ records: Array<{ id: string }> }>()
      .records[0]?.id;
    const refused = await call("PATCH", clientsId, {
      records: [{ id: clientId, fields: { orders: [] } }],
    });
    expect(refused.statusCode).toBe(403);
  });

  it("writes many rows in few statements, and names each one's id in order", async () => {
    const table = await findLiveTable(database, clientsId);
    if (!table) throw new Error("no table");
    const scope = await loadRowScope(
      database,
      { userId: ownerId, bindings: await loadBindings(database, ownerId) },
      table,
    );
    // Runs of the same fields, a row of other fields between them, an
    // empty value, and a row that sets nothing.
    const rows = Array.from({ length: 120 }, (_, index) => {
      const values: Record<string, string | null> =
        index === 60
          ? {}
          : index % 25 === 7
            ? { name: `Bulk ${String(index)}`, city: "Lyon", balance: null }
            : { name: `Bulk ${String(index)}` };
      return { values };
    });
    const ids = await createRows(
      { db: database, bus: recorder.bus, log: () => undefined },
      scope,
      rows,
      { source: "web" },
    );
    expect(ids).toHaveLength(120);
    const stored = await sql<{
      id: string;
      name: string | null;
      city: string | null;
      seq: string;
    }>`
      select "id", "name", "city", "ag_seq"::text as seq
      from ${sql.table(table.physicalName)}
      where "id" = any(${ids}::uuid[])
    `.execute(database);
    const byId = new Map(stored.rows.map((row) => [row.id, row]));
    expect(ids.map((id) => byId.get(id)?.name ?? null)).toEqual(
      rows.map((row) => row.values.name ?? null),
    );
    expect(byId.get(ids[7] ?? "")?.city).toBe("Lyon");
    // Created in the order given: the sequence follows it.
    const sequence = ids.map((id) => BigInt(byId.get(id)?.seq ?? "0"));
    expect(
      sequence.every(
        (value, index) => index === 0 || value > (sequence[index - 1] ?? 0n),
      ),
    ).toBe(true);
    // Each row is in the audit trail, as when written one at a time.
    const audited = await database
      .selectFrom("auditEvents")
      .select("recordId")
      .where("tableId", "=", clientsId)
      .where("action", "=", "insert")
      .where("recordId", "in", ids)
      .execute();
    expect(audited).toHaveLength(120);
  });

  it("refuses a whole update when one of its rows is missing", async () => {
    const created = await call("POST", clientsId, {
      records: [
        { fields: { name: "Kept one" } },
        { fields: { name: "Kept two" } },
      ],
    });
    const [first, second] = created
      .json<{ records: Array<{ id: string }> }>()
      .records.map((record) => record.id);
    const refused = await call("PATCH", clientsId, {
      records: [
        { id: first, fields: { name: "Changed one" } },
        {
          id: "00000000-0000-4000-8000-00000000dead",
          fields: { name: "Nobody" },
        },
        { id: second, fields: { name: "Changed two" } },
      ],
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    const names = async () => {
      const read = await Promise.all(
        [first, second].map((id) =>
          app.inject({
            method: "GET",
            url: `/api/v1/tables/${clientsId}/records/${id ?? ""}`,
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
      );
      return read.map(
        (answer) => answer.json<{ fields: { name: unknown } }>().fields.name,
      );
    };
    expect(await names()).toEqual(["Kept one", "Kept two"]);
    // The same update without the missing row goes through, both rows.
    const accepted = await call("PATCH", clientsId, {
      records: [
        { id: second, fields: { name: "Changed two" } },
        { id: first, fields: { name: "Changed one" } },
      ],
    });
    expect(accepted.statusCode).toBe(200);
    expect(await names()).toEqual(["Changed one", "Changed two"]);
  });

  it("indexes a link's foreign key, and gives one to a link made before", async () => {
    const orders = await database
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", ordersId)
      .executeTakeFirstOrThrow();
    const name = indexName(orders.physicalName, "client", "ix");
    const found = async () =>
      (
        await sql<{ indexdef: string }>`
          select indexdef from pg_indexes
          where tablename = ${orders.physicalName} and indexname = ${name}
        `.execute(database)
      ).rows.map((row) => row.indexdef);
    expect(await found()).toEqual([
      expect.stringContaining("(client)") as string,
    ]);
    // A link made before the index existed: the migration names it alike.
    await sql.raw(`drop index "${name}"`).execute(database);
    expect(await found()).toEqual([]);
    const migration = await readFile(
      new URL(
        "../../../../packages/db/migrations/0062_link_column_indexes.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await sql.raw(migration).execute(database);
    expect(await found()).toHaveLength(1);
    // The other side of the link stores nothing, and gets no index.
    const clients = await database
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", clientsId)
      .executeTakeFirstOrThrow();
    const others = await sql<{ indexname: string }>`
      select indexname from pg_indexes
      where tablename = ${clients.physicalName} and indexname like 'ix_%'
    `.execute(database);
    expect(others.rows.map((row) => row.indexname)).toEqual([
      indexName(clients.physicalName, "ag_seq", "ix"),
    ]);
  });
});
