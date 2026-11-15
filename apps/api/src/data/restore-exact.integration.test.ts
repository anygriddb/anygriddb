/**
 * A deleted row brought back holds its values as they were, a number of
 * thirty digits included: the database reads the row where the trail kept
 * it, and nothing of it goes through a JavaScript number on the way.
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
import { insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");
const EXACT = "123456789012345678901234567890.123456789";

describe("a deleted row brought back", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let token = "";
  let ownerId = "";
  let baseId = "";
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("restore_exact");
    db = created.db;
    close = created.close;
    const owner = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.org`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = owner.id;
    baseId = (await insertBase(db, ownerId, { name: `Ledger ${suffix}` })).id;
    tableId = (
      await insertTable(db, ownerId, {
        baseId,
        name: "Entries",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "amount", label: "Amount", fieldType: "number" },
          {
            name: "tags",
            label: "Tags",
            fieldType: "multi_select",
            config: {
              options: [
                { name: "a", color: "red" },
                { name: "b", color: "blue" },
              ],
            },
          },
          { name: "due", label: "Due", fieldType: "date" },
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
        .insertInto("roleBindings")
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

  async function records(): Promise<
    Array<{ id: string; fields: Record<string, unknown> }>
  > {
    const answer = await app.inject({
      method: "GET",
      url: `/api/v1/tables/${tableId}/records`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    return answer.json<{
      records: Array<{ id: string; fields: Record<string, unknown> }>;
    }>().records;
  }

  it("holds a number past sixteen digits as it was, and its other values", async () => {
    const made = await app.inject({
      method: "POST",
      url: `/api/v1/tables/${tableId}/records`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        records: [
          {
            fields: {
              name: "Exact",
              amount: EXACT,
              tags: ["a", "b"],
              due: "2026-11-15",
            },
          },
        ],
      },
    });
    expect(made.statusCode, made.body).toBe(200);
    const before = (await records()).find(
      (record) => record.fields.name === "Exact",
    );
    expect(before?.fields.amount).toBe(EXACT);

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
    const id = before?.id ?? "";
    await deleteRows(services, scope, [id], { source: "web" });
    expect((await records()).map((record) => record.id)).not.toContain(id);

    await restoreRows(services, scope, [id], { source: "web" });
    const after = (await records()).find((record) => record.id === id);
    expect(after?.fields).toEqual(before?.fields);
    expect(after?.fields.amount).toBe(EXACT);
  });

  it("brings back no row that was not deleted", async () => {
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
    const [live] = await records();
    await expect(
      restoreRows(services, scope, [live?.id ?? ""], { source: "web" }),
    ).rejects.toThrow();
    await expect(
      restoreRows(services, scope, ["11111111-1111-4111-8111-111111111111"], {
        source: "web",
      }),
    ).rejects.toThrow();
    expect(await records()).toHaveLength(1);
  });
});
