import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { withAudit } from "../data/audit-context.js";
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
    app = Fastify();
    await app.register(cookie);
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
