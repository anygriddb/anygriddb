/**
 * A colour and a place (ROADMAP #95), against a real database: a write
 * takes each in its one spelling and refuses anything else, the REST
 * API's typecast reads what a person types, a text field converted to
 * either keeps the values that read as one, in the spelling a write
 * would have given them, and a place is found by the filter a map uses.
 */
import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import { formatPlace, parseColor, parsePlace } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { registerRestApi } from "../rest-api.js";
import { findLiveTable } from "../services/rows.js";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import { insertBase, insertTable, updateColumn } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");

describe("a colour and a place", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let token = "";
  let ownerId = "";
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("color_place");
    db = created.db;
    close = created.close;
    const owner = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.org`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    ownerId = owner.id;
    const base = await insertBase(db, ownerId, { name: `Places ${suffix}` });
    tableId = (
      await insertTable(db, ownerId, {
        baseId: base.id,
        name: "Shops",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "tint", label: "Tint", fieldType: "color" },
          { name: "spot", label: "Spot", fieldType: "place" },
          { name: "typed_tint", label: "Typed tint", fieldType: "text" },
          { name: "typed_spot", label: "Typed spot", fieldType: "text" },
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
          scopeId: base.id,
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
    expect(answer.statusCode).toBe(200);
    return answer
      .json<{ records: Array<{ fields: Record<string, unknown> }> }>()
      .records.map((record) => record.fields);
  }

  it("takes each in its one spelling, and refuses any other", async () => {
    const kept = await write({
      name: "Paris",
      tint: "#1f3fae",
      spot: "48.8566,2.3522",
    });
    expect(kept.statusCode).toBe(200);
    for (const fields of [
      { tint: "#1F3FAE" },
      { tint: "1f3fae" },
      { tint: "#abc" },
      { tint: "blue" },
      { spot: "48.8566, 2.3522" },
      { spot: "91,0" },
      { spot: "0,181" },
      { spot: "48.85661234567,2.3522" },
      { spot: "Paris" },
    ]) {
      const refused = await write({ name: "Refused", ...fields });
      expect([JSON.stringify(fields), refused.statusCode]).toEqual([
        JSON.stringify(fields),
        400,
      ]);
      expect(refused.json<{ code: string }>().code).toBe("invalid_cell");
    }
    expect(await rows()).toHaveLength(1);
  });

  it("reads what a person types when asked to typecast", async () => {
    const typed = await write(
      { name: "Sydney", tint: "#ABC", spot: "-33.8688 151.2093" },
      true,
    );
    expect(typed.statusCode).toBe(200);
    const sydney = (await rows()).find((row) => row.name === "Sydney");
    expect(sydney).toMatchObject({
      tint: "#aabbcc",
      spot: "-33.8688,151.2093",
    });
  });

  it("finds the rows that have a place, as a map asks", async () => {
    await write({ name: "Nowhere" });
    const all = await rows();
    expect(all.map((row) => row.name).sort()).toEqual([
      "Nowhere",
      "Paris",
      "Sydney",
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({
        conjunction: "and",
        conditions: [{ column: "spot", op: "is_not_empty" }],
      }),
    );
    const placed = await rows(`?filter=${filter}`);
    expect(placed.map((row) => row.name).sort()).toEqual(["Paris", "Sydney"]);
  });

  it("keeps the values that read as a colour or a place when a text field becomes one", async () => {
    const tints = [
      "#ABC",
      "1f3fae",
      " #1F3FAE ",
      "not a colour",
      "#12345",
      "\t#1f3fae\n",
    ];
    const spots = [
      "48.8566, 2.3522",
      "48.8566;2.3522",
      "-33.8688 151.2093",
      "+12.5,-0.000",
      "48.85661234567,2.35",
      "91, 0",
      "0, 180.5",
      "abc",
      "1,2,3",
      "48.8566,\u00a02.3522",
      "48.8566\t2.3522",
      `48.${"8".repeat(70)},2`,
    ];
    const count = Math.max(tints.length, spots.length);
    for (let index = 0; index < count; index += 1) {
      const made = await write({
        name: `typed-${String(index).padStart(2, "0")}`,
        ...(tints[index] === undefined ? {} : { typed_tint: tints[index] }),
        ...(spots[index] === undefined ? {} : { typed_spot: spots[index] }),
      });
      expect(made.statusCode).toBe(200);
    }
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    await updateColumn(db, ownerId, table, {
      name: "typed_tint",
      fieldType: "color",
    });
    await updateColumn(db, ownerId, table, {
      name: "typed_spot",
      fieldType: "place",
    });

    const typed = (await rows())
      .filter((row) => String(row.name).startsWith("typed-"))
      .sort((left, right) =>
        String(left.name).localeCompare(String(right.name)),
      );
    // The spelling the database gives is the one a write gives.
    const place = (text: string) => {
      const read = parsePlace(text);
      return read ? (formatPlace(read) ?? null) : null;
    };
    expect(typed.map((row) => row.typed_tint ?? null)).toEqual(
      Array.from({ length: count }, (_, index) =>
        tints[index] === undefined ? null : (parseColor(tints[index]) ?? null),
      ),
    );
    expect(typed.map((row) => row.typed_spot ?? null)).toEqual(
      Array.from({ length: count }, (_, index) =>
        spots[index] === undefined ? null : place(spots[index]),
      ),
    );
    // And what that is, said once.
    expect(typed.slice(0, 5).map((row) => row.typed_tint ?? null)).toEqual([
      "#aabbcc",
      "#1f3fae",
      "#1f3fae",
      null,
      null,
    ]);
    expect(typed.map((row) => row.typed_spot ?? null)).toEqual([
      "48.8566,2.3522",
      "48.8566,2.3522",
      "-33.8688,151.2093",
      "12.5,0",
      "48.856612,2.35",
      null,
      null,
      null,
      null,
      "48.8566,2.3522",
      "48.8566,2.3522",
      null,
    ]);
  });

  it("gives a colour back to a text field as it is", async () => {
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    await updateColumn(db, ownerId, table, { name: "tint", fieldType: "text" });
    const paris = (await rows()).find((row) => row.name === "Paris");
    expect(paris?.tint).toBe("#1f3fae");
  });
});
