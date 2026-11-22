import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { withAudit } from "../data/audit-context.js";
import { addRelation } from "../data/relations.js";
import { setRowStatus, signRow } from "../data/rows.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import { registerMcp } from "./http.js";

const suffix = randomBytes(6).toString("hex");
const PUBLIC_URL = "https://grid.example.org";

type RpcReply = {
  status: number;
  body: {
    result?: {
      tools?: Array<{ name: string; annotations?: Record<string, unknown> }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: Array<{ text: string }>;
    };
    error?: unknown;
    code?: string;
  };
};

describe("the MCP server", () => {
  let database: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let url = "";
  let writer = "";
  let reader = "";
  let noDelete = "";
  let baseId = "";
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("mcp");
    database = created.db;
    close = created.close;
    const owner = (
      await database
        .insertInto("users")
        .values({ email: `mcp-${suffix}@example.com`, displayName: "Owner" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    baseId = (await insertBase(database, owner, { name: "Ventes" })).id;
    tableId = (
      await insertTable(database, owner, {
        baseId,
        name: "Clients",
        columns: [{ name: "name", label: "Nom", fieldType: "text" }],
      })
    ).id;
    // An editor's tokens: an owner would need a second factor first.
    const editor = (
      await database
        .insertInto("users")
        .values({ email: `mcp-ed-${suffix}@example.com`, displayName: "Ed" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await withAudit(database, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({
          userId: editor,
          role: "editor",
          scope: "base",
          scopeId: baseId,
        })
        .execute(),
    );
    writer = (await createApiToken(database, editor, "agent")).token;
    reader = (
      await createApiToken(database, editor, "lecture", { readOnly: true })
    ).token;
    noDelete = (
      await createApiToken(database, editor, "agent-safe", {
        allowDelete: false,
      })
    ).token;
    app = Fastify();
    await app.register(cookie);
    // What the rate limit leaves on a reply before the route runs.
    app.addHook("onRequest", async (_request, reply) => {
      reply.header("x-ratelimit-remaining", "41");
    });
    registerMcp(app, {
      db: database,
      bus: recordingBus().bus,
      publicUrl: PUBLIC_URL,
    });
    url = `${await app.listen({ host: "127.0.0.1", port: 0 })}/mcp`;
  });

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  async function rpc(
    token: string | null,
    method: string,
    params: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<RpcReply> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return {
      status: response.status,
      body: (await response.json()) as RpcReply["body"],
    };
  }

  it("starts a session and lists the record tools, reads marked as reads", async () => {
    const init = await rpc(writer, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    const listed = await rpc(writer, "tools/list");
    const tools = listed.body.result?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_records",
      "delete_records",
      "get_openapi",
      "get_record",
      "list_bases",
      "list_records",
      "list_tables",
      "update_records",
    ]);
    const read = tools.find((tool) => tool.name === "list_records");
    expect(read?.annotations?.readOnlyHint).toBe(true);
  });

  it("writes and reads rows under the token's rights", async () => {
    const created = await rpc(writer, "tools/call", {
      name: "create_records",
      arguments: { tableId, records: [{ fields: { name: "Acme" } }] },
    });
    expect(created.body.result?.isError).toBeFalsy();
    const listed = await rpc(writer, "tools/call", {
      name: "list_records",
      arguments: { tableId },
    });
    const records = listed.body.result?.structuredContent?.records as Array<{
      fields: Record<string, unknown>;
    }>;
    expect(records.map((record) => record.fields.name)).toEqual(["Acme"]);
    const bases = await rpc(writer, "tools/call", {
      name: "list_bases",
      arguments: {},
    });
    expect(JSON.stringify(bases.body.result?.structuredContent)).toContain(
      baseId,
    );
  });

  it("offers a read-only token no tool that writes, and refuses its writes", async () => {
    const listed = await rpc(reader, "tools/list");
    const names = (listed.body.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("list_records");
    expect(names).not.toContain("create_records");
    const refused = await rpc(reader, "tools/call", {
      name: "create_records",
      arguments: { tableId, records: [{ fields: { name: "Globex" } }] },
    });
    expect(refused.body.result?.isError ?? refused.body.error).toBeTruthy();
  });

  it("offers a no-delete write token create and update, not delete", async () => {
    const listed = await rpc(noDelete, "tools/list");
    const names = (listed.body.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("create_records");
    expect(names).toContain("update_records");
    expect(names).not.toContain("delete_records");
    const created = await rpc(noDelete, "tools/call", {
      name: "create_records",
      arguments: { tableId, records: [{ fields: { name: "Keep" } }] },
    });
    expect(created.body.result?.isError).toBeFalsy();
    const refused = await rpc(noDelete, "tools/call", {
      name: "delete_records",
      arguments: { tableId, recordIds: ["1"] },
    });
    expect(refused.body.result?.isError ?? refused.body.error).toBeTruthy();
  });

  it("refuses an edit of a link that would change a signed row", async () => {
    const owner = (
      await database
        .selectFrom("users")
        .select("id")
        .where("email", "=", `mcp-${suffix}@example.com`)
        .executeTakeFirstOrThrow()
    ).id;
    const make = async (name: string) =>
      insertTable(database, owner, {
        baseId,
        name,
        columns: [{ name: "name", label: "Nom", fieldType: "text" }],
      });
    const targets = (await make("Cibles")).id;
    const sources = (await make("Porteurs")).id;
    const relation = await addRelation(database, owner, {
      tableId: sources,
      name: "liens",
      kind: "many_to_many",
      targetTableId: targets,
      twoWay: true,
    });
    const inverse = (
      await database
        .selectFrom("dataColumns")
        .select("name")
        .where("id", "=", relation.inverseId ?? "")
        .executeTakeFirstOrThrow()
    ).name;
    const create = async (table: string, fields: Record<string, unknown>) => {
      const made = await rpc(writer, "tools/call", {
        name: "create_records",
        arguments: { tableId: table, records: [{ fields }] },
      });
      const records = made.body.result?.structuredContent?.records as Array<{
        id: string;
      }>;
      return records[0]?.id ?? "";
    };
    const target = await create(targets, { name: "cible" });
    const signed = await create(sources, { name: "signe", liens: [target] });
    const draft = await create(sources, { name: "brouillon" });
    const physical = await database
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", sources)
      .executeTakeFirstOrThrow();
    for (const status of ["submitted", "locked"] as const) {
      await setRowStatus(database, {
        userId: owner,
        role: "owner",
        table: physical,
        rowId: signed,
        status,
      });
    }
    await signRow(database, {
      userId: owner,
      table: physical,
      rowId: signed,
      meaning: "Approved",
    });
    const refused = await rpc(writer, "tools/call", {
      name: "update_records",
      arguments: {
        tableId: targets,
        records: [{ id: target, fields: { [inverse]: [draft] } }],
      },
    });
    expect(refused.body.result?.isError).toBe(true);
    expect(JSON.stringify(refused.body)).toContain("Row locked");
    const read = await rpc(writer, "tools/call", {
      name: "get_record",
      arguments: { tableId: sources, recordId: signed },
    });
    expect(JSON.stringify(read.body)).toContain(target);
    // Once nothing sealed is on the other side, the same edit goes through.
    const kept = await rpc(writer, "tools/call", {
      name: "update_records",
      arguments: {
        tableId: targets,
        records: [{ id: target, fields: { [inverse]: [signed, draft] } }],
      },
    });
    expect(kept.body.result?.isError ?? false).toBe(false);
  });

  it("refuses a batch, and runs none of its calls", async () => {
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "create_records",
        arguments: { tableId, records: [{ fields: { name: "from a batch" } }] },
      },
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        authorization: `Bearer ${writer}`,
      },
      body: JSON.stringify([call(1), call(2)]),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_input" });
    const listed = await rpc(reader, "tools/call", {
      name: "list_records",
      arguments: { tableId, limit: 100 },
    });
    expect(JSON.stringify(listed.body)).not.toContain("from a batch");
  });

  it("keeps the rate limit's headers on its answer", async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        authorization: `Bearer ${reader}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-remaining")).toBe("41");
  });

  it("answers GET and DELETE at once: each call stands alone", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: "/mcp",
        headers: {
          authorization: `Bearer ${writer}`,
          accept: "application/json, text/event-stream",
        },
      });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
    }
  });

  it("refuses a call without a token, with a session cookie, or from another origin", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
    expect(
      (await rpc(null, "tools/list", {}, { cookie: "__Host-ag_session=x" }))
        .status,
    ).toBe(401);
    expect((await rpc("ag_unknown", "tools/list")).status).toBe(401);
    const foreign = await rpc(
      writer,
      "tools/list",
      {},
      { origin: "https://evil.example.com" },
    );
    expect(foreign.status).toBe(403);
    const ours = await rpc(writer, "tools/list", {}, { origin: PUBLIC_URL });
    expect(ours.status).toBe(200);
  });
});
