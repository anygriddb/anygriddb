import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
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

const suffix = randomBytes(6).toString("hex");

describe("row writes through the REST API", () => {
  let database: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  const recorder = recordingBus();
  let token = "";
  let clientsId = "";
  let ordersId = "";

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
});
