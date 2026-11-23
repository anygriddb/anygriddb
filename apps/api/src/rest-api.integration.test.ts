/**
 * What the REST API answers to a request its caller got wrong, against a
 * real database: a refusal of the caller's own, with a code that tells
 * which, and never a fault of the server.
 */
import { randomBytes, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "./auth/tokens.js";
import { withAudit } from "./data/audit-context.js";
import { loadEngine } from "./data/engine.js";
import { readTransaction } from "./data/rows.js";
import { insertBase, insertTable } from "./data/schema-ops.js";
import { recordingBus } from "./realtime/recording-bus.test-helpers.js";
import { registerRestApi } from "./rest-api.js";
import { createTestDatabase } from "./test-database.js";

const suffix = randomBytes(6).toString("hex");

describe("a request its caller got wrong", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let token = "";
  let tableId = "";

  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    more: { body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(more.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...more.headers,
      },
      ...(more.body === undefined
        ? {}
        : { payload: JSON.stringify(more.body) }),
    });

  /** The status and the code of an answer, as a caller reads them. */
  const refusal = async (answer: ReturnType<typeof call>) => {
    const got = await answer;
    return [got.statusCode, got.json<{ code?: string }>().code];
  };

  const create = async (name: string, headers?: Record<string, string>) => {
    const made = await call("POST", `/tables/${tableId}/records`, {
      body: { records: [{ fields: { name } }] },
      headers: headers ?? { "x-reason": "made" },
    });
    expect(made.statusCode, made.body).toBe(200);
    return made.json<{ records: Array<{ id: string }> }>().records[0]?.id ?? "";
  };

  beforeAll(async () => {
    const created = await createTestDatabase("rest-refusals");
    db = created.db;
    close = created.close;
    const owner = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.org`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const base = await insertBase(db, owner.id, { name: "Refusals" });
    tableId = (
      await insertTable(db, owner.id, {
        baseId: base.id,
        name: "Things",
        // A write to it gives its reason, which the trail keeps.
        columns: [
          {
            name: "name",
            label: "Name",
            fieldType: "text",
            requireReason: true,
          },
        ],
      })
    ).id;
    // The first account is an administrator, and a token needs its second
    // factor: the API is called by an editor of the base.
    const editor = await db
      .insertInto("users")
      .values({ email: `editor-${suffix}@example.org`, displayName: "Editor" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await withAudit(db, { userId: owner.id, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({
          userId: editor.id,
          role: "editor",
          scope: "base",
          scopeId: base.id,
        })
        .execute(),
    );
    token = (await createApiToken(db, editor.id, "refusals")).token;
    // A path takes an id as long as the server's own does.
    app = Fastify({ routerOptions: { maxParamLength: 6_000 } });
    await app.register(cookie);
    registerRestApi(app, {
      db,
      bus: recordingBus().bus,
      publicUrl: "http://localhost",
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  it("refuses a table, a base, or a record its path cannot name", async () => {
    expect(await refusal(call("GET", "/tables/not-a-uuid/records"))).toEqual([
      400,
      "invalid_input",
    ]);
    expect(await refusal(call("GET", "/bases/not-a-uuid/tables"))).toEqual([
      400,
      "invalid_input",
    ]);
    expect(
      await refusal(call("GET", "/bases/not-a-uuid/openapi.json")),
    ).toEqual([400, "invalid_input"]);
    expect(
      await refusal(call("DELETE", "/tables/not-a-uuid/records?records=x")),
    ).toEqual([400, "invalid_input"]);
    expect(
      await refusal(call("POST", "/tables/not-a-uuid/records", { body: {} })),
    ).toEqual([400, "invalid_input"]);
    expect(
      await refusal(call("PATCH", "/tables/not-a-uuid/records", { body: {} })),
    ).toEqual([400, "invalid_input"]);
    // A control character, and more than an id holds.
    expect(
      await refusal(call("GET", `/tables/${tableId}/records/a%07b`)),
    ).toEqual([400, "invalid_record_id"]);
    expect(
      await refusal(
        call("GET", `/tables/${tableId}/records/${"a".repeat(2000)}`),
      ),
    ).toEqual([400, "invalid_record_id"]);
  });

  it("refuses a query it cannot read, a parameter given twice among them", async () => {
    const id = await create("queried");
    const record = `/tables/${tableId}/records/${id}`;
    expect(await refusal(call("GET", `${record}?fieldKey=bogus`))).toEqual([
      400,
      "invalid_query",
    ]);
    expect(await refusal(call("GET", `${record}?fieldKey=`))).toEqual([
      400,
      "invalid_query",
    ]);
    expect(
      await refusal(call("GET", `${record}?fieldKey=name&fieldKey=label`)),
    ).toEqual([400, "invalid_query"]);
    expect(
      await refusal(
        call("DELETE", `/tables/${tableId}/records?records=${id}&records=x`),
      ),
    ).toEqual([400, "invalid_record_id"]);
    // A whole number is written in digits: `Number` read these three.
    for (const limit of ["0x10", "1e3", "%201"]) {
      expect(
        await refusal(call("GET", `/tables/${tableId}/records?limit=${limit}`)),
      ).toEqual([400, "invalid_query"]);
    }
    expect(
      await refusal(call("GET", `/tables/${tableId}/records?sort=`)),
    ).toEqual([400, "invalid_query"]);
    expect(
      (await call("GET", `/tables/${tableId}/records?limit=10&offset=0`))
        .statusCode,
    ).toBe(200);
    // What it can read, it answers.
    const read = await call("GET", `${record}?fieldKey=label`);
    expect(read.statusCode, read.body).toBe(200);
    expect((await call("GET", `/tables/${tableId}/records`)).statusCode).toBe(
      200,
    );
  });

  it("keeps a reason as it was sent when it does not decode", async () => {
    const reasonOf = async (id: string) =>
      (
        await db
          .selectFrom("auditEvents")
          .select("reason")
          .where("recordId", "=", id)
          .where("action", "=", "insert")
          .executeTakeFirst()
      )?.reason;
    // A percent sign alone is no encoding: it was a fault of the server.
    for (const reason of ["remise de 100%", "%zz", "%E0%A4%A"]) {
      const id = await create("reasoned", { "x-reason": reason });
      expect(await reasonOf(id)).toBe(reason);
    }
    // Encoded, it is read: a header carries any letter that way.
    const encoded = await create("encoded", {
      "x-reason": "remise%20de%20100%25%20%C3%A9t%C3%A9",
    });
    expect(await reasonOf(encoded)).toBe("remise de 100% été");
  });

  it("refuses to say updated a row that is not there, with no field to write", async () => {
    const REASON = { "x-reason": "corrected" };
    const patch = (
      id: string,
      fields: Record<string, unknown>,
      headers?: Record<string, string>,
    ) =>
      call("PATCH", `/tables/${tableId}/records`, {
        body: { records: [{ id, fields }] },
        ...(headers ? { headers } : {}),
      });
    // As with a field to write: the same two refusals.
    expect(await refusal(patch(randomUUID(), {}))).toEqual([400, "no_row"]);
    expect(await refusal(patch(randomUUID(), { name: "x" }, REASON))).toEqual([
      400,
      "no_row",
    ]);
    expect(await refusal(patch("zzz", {}))).toEqual([400, "invalid_row_id"]);
    expect(await refusal(patch("zzz", { name: "x" }, REASON))).toEqual([
      400,
      "invalid_row_id",
    ]);
    // One of them missing refuses them all.
    const id = await create("kept");
    const mixed = await call("PATCH", `/tables/${tableId}/records`, {
      body: {
        records: [
          { id, fields: {} },
          { id: randomUUID(), fields: {} },
        ],
      },
    });
    expect(mixed.statusCode, mixed.body).toBe(400);
    // A row that is there, and nothing to write: answered, and unchanged.
    const unchanged = await patch(id, {});
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(unchanged.json()).toEqual({ records: [{ id }] });
    const read = await call("GET", `/tables/${tableId}/records/${id}`);
    expect(read.json<{ fields: { name: string } }>().fields.name).toBe("kept");
  });

  it("says that a read ran past its time, and not that the server failed", async () => {
    const { engine } = await loadEngine(db, tableId, () => true);
    const stopped = readTransaction(db, engine, async (run) => {
      // The read's own limit is fifteen seconds: brought down for the test.
      await run({ text: "set local statement_timeout = '20ms'", values: [] });
      return run({ text: "select pg_sleep(2)", values: [] });
    });
    await expect(stopped).rejects.toMatchObject({
      code: "read_timeout",
      status: 503,
    });
    // Any other failure stays what it was.
    await expect(
      readTransaction(db, engine, (run) =>
        run({ text: "select 1 / 0", values: [] }),
      ),
    ).rejects.not.toMatchObject({ code: "read_timeout" });
  });
});
