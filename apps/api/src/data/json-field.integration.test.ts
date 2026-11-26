/**
 * A JSON field (ROADMAP #97), against a real database: a write takes a
 * document however it is spaced and the database keeps it as jsonb, in
 * the one spelling a read gives; anything that is not an object or a
 * list is refused; a filter and a formula read into it; a text field
 * converted to one keeps what reads as a document; a row deleted and
 * brought back holds its document as it was.
 */
import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { registerRestApi } from "../rest-api.js";
import {
  deleteRows,
  findLiveTable,
  loadRowScope,
  restoreRows,
} from "../services/rows.js";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import { insertBase, insertTable, updateColumn } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");

describe("a JSON field", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let token = "";
  let ownerId = "";
  let baseId = "";
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("json_field");
    db = created.db;
    close = created.close;
    const owner = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.org`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = owner.id;
    const base = await insertBase(db, ownerId, { name: `Documents ${suffix}` });
    baseId = base.id;
    tableId = (
      await insertTable(db, ownerId, {
        baseId,
        name: "Orders",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "meta", label: "Meta", fieldType: "json" },
          { name: "typed", label: "Typed", fieldType: "long_text" },
          {
            name: "city",
            label: "City",
            fieldType: "formula",
            formulaSource: 'JSON_EXTRACT({Meta}, "$.address.city")',
          },
          {
            name: "second",
            label: "Second",
            fieldType: "formula",
            formulaSource: 'JSON_EXTRACT({Meta}, "$.items[1]")',
          },
        ],
      })
    ).id;
    // An owner's token asks for a second factor: an editor writes here.
    const editor = await db
      .insertInto("users")
      .values({ email: `editor-${suffix}@example.org`, displayName: "Editor" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await withAudit(db, { userId: ownerId, source: "web" }, (tx) =>
      tx
        .insertInto("attributions")
        .values({
          userId: editor.id,
          role: "editor",
          scope: "base",
          scopeId: baseId,
        })
        .execute(),
    );
    token = (await createApiToken(db, editor.id, "test")).token;
    app = Fastify();
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

  const write = (fields: Record<string, unknown>, typecast = false) =>
    app.inject({
      method: "POST",
      url: `/api/v1/tables/${tableId}/records`,
      headers: { authorization: `Bearer ${token}` },
      payload: { records: [{ fields }], ...(typecast ? { typecast } : {}) },
    });

  /** The rows as the API reads them, by name. */
  async function rows(query = ""): Promise<Record<string, unknown>[]> {
    const answer = await app.inject({
      method: "GET",
      url: `/api/v1/tables/${tableId}/records${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    return answer
      .json<{ records: Array<{ fields: Record<string, unknown> }> }>()
      .records.map((record) => record.fields);
  }
  const named = async (name: string) =>
    (await rows()).find((row) => row.name === name);

  it("keeps a document as the database spells it, however it was spaced", async () => {
    const kept = await write({
      name: "Paris",
      meta: '{"items":["a","b"],"address":{"city":"Paris","zip":"75001"}}',
    });
    expect(kept.statusCode, kept.body).toBe(200);
    // jsonb's own order of names, a space after each colon and comma.
    expect((await named("Paris"))?.meta).toBe(
      '{"items": ["a", "b"], "address": {"zip": "75001", "city": "Paris"}}',
    );
    const laidOut = await write({
      name: "Lyon",
      meta: '{\n  "address": {\n    "city": "Lyon"\n  },\n  "items": []\n}',
    });
    expect(laidOut.statusCode, laidOut.body).toBe(200);
    expect((await named("Lyon"))?.meta).toBe(
      '{"items": [], "address": {"city": "Lyon"}}',
    );
    // A number leaves as it came: forty digits, and a zero that counts.
    const exact = await write({
      name: "Exact",
      meta: '{"n":1234567890123456789012345678901234567890,"e":1.50}',
    });
    expect(exact.statusCode, exact.body).toBe(200);
    expect((await named("Exact"))?.meta).toBe(
      '{"e": 1.50, "n": 1234567890123456789012345678901234567890}',
    );
    const stored = await db
      .selectFrom("information_schema.columns" as never)
      .select("data_type" as never)
      .where("column_name" as never, "=", "meta" as never)
      .execute();
    expect(stored).toContainEqual({ dataType: "jsonb" });
  });

  it("refuses what is not an object or a list", async () => {
    const before = (await rows()).length;
    for (const meta of [
      "12",
      '"text"',
      "true",
      "null",
      "{bad",
      '{"a":1,}',
      "plain words",
      `${"[".repeat(101)}${"]".repeat(101)}`,
      // JSON takes these two; the database does not.
      '{"a": "x\\u0000y"}',
      '["\\ud800"]',
    ]) {
      const refused = await write({ name: "Refused", meta });
      expect([meta.slice(0, 20), refused.statusCode]).toEqual([
        meta.slice(0, 20),
        400,
      ]);
      expect(refused.json<{ code: string }>().code).toBe("invalid_cell");
    }
    // Typecast reads what a person types, and is no way round the rule.
    const typed = await write({ name: "Refused", meta: "12" }, true);
    expect(typed.statusCode).toBe(400);
    expect(await rows()).toHaveLength(before);
  });

  it("reads a typed document, and a list sent as one, when asked to typecast", async () => {
    const typed = await write(
      { name: "Typed", meta: ' { "items" : [ "x" , "y" ] } ' },
      true,
    );
    expect(typed.statusCode, typed.body).toBe(200);
    expect((await named("Typed"))?.meta).toBe('{"items": ["x", "y"]}');
    const list = await write({ name: "List", meta: ["x", "y"] }, true);
    expect(list.statusCode, list.body).toBe(200);
    expect((await named("List"))?.meta).toBe('["x", "y"]');
    const empty = await write({ name: "Empty", meta: "  " }, true);
    expect(empty.statusCode, empty.body).toBe(200);
    expect((await named("Empty"))?.meta ?? null).toBeNull();
  });

  it("is read into by a formula, and found by a filter on its text", async () => {
    const all = await rows();
    const cities = Object.fromEntries(
      all.map((row) => [row.name, row.city ?? null]),
    );
    expect(cities).toMatchObject({
      Paris: "Paris",
      Lyon: "Lyon",
      Exact: null,
      Empty: null,
    });
    expect(all.find((row) => row.name === "Paris")?.second).toBe("b");
    expect(all.find((row) => row.name === "Typed")?.second).toBe("y");
    const filter = (conditions: unknown[]) =>
      `?filter=${encodeURIComponent(JSON.stringify({ conjunction: "and", conditions }))}`;
    const found = await rows(
      filter([{ column: "meta", op: "contains", value: '"city": "Lyon"' }]),
    );
    expect(found.map((row) => row.name)).toEqual(["Lyon"]);
    const filled = await rows(filter([{ column: "meta", op: "is_not_empty" }]));
    expect(filled.map((row) => row.name).sort()).toEqual([
      "Exact",
      "List",
      "Lyon",
      "Paris",
      "Typed",
    ]);
    // Sorted as text, it is still read.
    const sorted = await rows("?sort=meta");
    expect(sorted).toHaveLength(all.length);
  });

  it("holds its document again once a deleted row is brought back", async () => {
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    const scope = await loadRowScope(
      db,
      {
        userId: ownerId,
        bindings: [{ role: "owner", scope: "base", scopeId: baseId }],
      },
      table,
    );
    const services = {
      db,
      bus: { publish: () => Promise.resolve() } as never,
      log: () => undefined,
    };
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/tables/${tableId}/records`,
      headers: { authorization: `Bearer ${token}` },
    });
    const id =
      listed
        .json<{
          records: Array<{ id: string; fields: Record<string, unknown> }>;
        }>()
        .records.find((record) => record.fields.name === "Exact")?.id ?? "";
    await deleteRows(services, scope, [id], { source: "web" });
    expect(await named("Exact")).toBeUndefined();
    // The trail holds the document as the object it is.
    const trail = await db
      .selectFrom("auditEvents")
      .select("oldValue")
      .where("tableId", "=", tableId)
      .where("recordId", "=", id)
      .where("action", "=", "delete")
      .executeTakeFirstOrThrow();
    expect(typeof (trail.oldValue as { meta: unknown }).meta).toBe("object");
    await restoreRows(services, scope, [id], { source: "web" });
    expect((await named("Exact"))?.meta).toBe(
      '{"e": 1.50, "n": 1234567890123456789012345678901234567890}',
    );
  });

  it("keeps what reads as a document when a text field becomes one", async () => {
    const texts = [
      '{"a":1}',
      " [1, 2,\n 3] ",
      "12",
      '"text"',
      "null",
      "plain words",
      '{"a":1,}',
      // Deeper than a write takes: it does not fit the field.
      `${"[".repeat(150)}${"]".repeat(150)}`,
      "",
    ];
    for (const [index, typed] of texts.entries()) {
      const made = await write({
        name: `typed-${String(index).padStart(2, "0")}`,
        ...(typed === "" ? {} : { typed }),
      });
      expect(made.statusCode, made.body).toBe(200);
    }
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    await updateColumn(db, ownerId, table, {
      name: "typed",
      fieldType: "json",
    });
    const typed = (await rows())
      .filter((row) => String(row.name).startsWith("typed-"))
      .sort((left, right) =>
        String(left.name).localeCompare(String(right.name)),
      );
    expect(typed.map((row) => row.typed ?? null)).toEqual([
      '{"a": 1}',
      "[1, 2, 3]",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("gives its text back to a text field", async () => {
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    await updateColumn(db, ownerId, table, {
      name: "meta",
      fieldType: "long_text",
    });
    expect((await named("Lyon"))?.meta).toBe(
      '{"items": [], "address": {"city": "Lyon"}}',
    );
    // The formula reads the text as it read the document.
    expect((await named("Lyon"))?.city).toBe("Lyon");
  });
});
