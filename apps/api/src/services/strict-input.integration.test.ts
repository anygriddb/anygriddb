/**
 * What a write takes against a real database: an exact number travels as
 * text and a rounded one is refused; an import refuses a value it would
 * have to cut or guess, on its line, and writes the lines around it; a
 * group's key and an aggregate read as exact, canonical text.
 */
import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import { createApiToken } from "../auth/tokens.js";
import { importIntoTable, type ImportSource } from "../data/import-commit.js";
import { withAudit } from "../data/audit-context.js";
import { aggregateRows, readAudit, readPage } from "../data/rows.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { registerRestApi } from "../rest-api.js";
import { createTestDatabase } from "../test-database.js";
import { revertRow } from "./revert-row.js";
import {
  createRows,
  findLiveTable,
  loadRowScope,
  updateRows,
  type RowScope,
} from "./rows.js";

const suffix = randomBytes(6).toString("hex");
/** 2^53 + 1, as a body writes it: `JSON.parse` makes it 2^53. */
const PAST_SAFE = "9007199254740993";
const META = { source: "web" };

describe("a value is read exactly, or refused", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let owner = "";
  let token = "";
  let editorId = "";
  let tableId = "";
  let scope: RowScope;
  const recorder = recordingBus();
  const deps = () => ({ db, bus: recorder.bus, log: () => undefined });

  async function refusal(write: Promise<unknown>): Promise<string> {
    try {
      await write;
    } catch (error) {
      if (error instanceof AppError) return error.code;
      throw error;
    }
    return "written";
  }

  /** What PostgreSQL holds in a field, for the row named `name`. */
  async function stored(name: string, column: string): Promise<unknown> {
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    const row = await db
      .selectFrom(table.physicalName as never)
      .select(column as never)
      .where("name" as never, "=", name as never)
      .$castTo<Record<string, unknown>>()
      .executeTakeFirst();
    return row?.[column];
  }

  const post = (body: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/tables/${tableId}/records`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: body,
    });

  /** A table of its own, with a date of each kind, for what a date reads. */
  async function datedTable() {
    const base = await insertBase(db, owner, { name: `Dated ${suffix}` });
    const id = (
      await insertTable(db, owner, {
        baseId: base.id,
        name: "Dated",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "plain", label: "Plain", fieldType: "date" },
          {
            name: "us",
            label: "Us",
            fieldType: "date",
            config: { date: { format: "us" } },
          },
          {
            name: "eu",
            label: "Eu",
            fieldType: "date",
            config: { date: { format: "eu" } },
          },
        ],
      })
    ).id;
    const table = await findLiveTable(db, id);
    if (!table) throw new Error("no table");
    return table;
  }

  function fileOf(headers: string[], rows: string[][]): ImportSource {
    return {
      headers,
      total: rows.length,
      async *batches() {
        yield rows.map((cells, index) => ({ line: index + 2, cells }));
      },
    };
  }

  async function run(
    source: ImportSource,
    more: { decimalMark?: "." | ","; timeZone?: string } = {},
  ) {
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    return importIntoTable(db, {
      userId: owner,
      table,
      source,
      mapping: source.headers.map((_, index) => ({
        source: index,
        column: ["name", "qty", "body"][index] ?? "",
      })),
      addOptions: false,
      canManage: true,
      eventKey: `import:strict-${randomBytes(4).toString("hex")}`,
      ...more,
    });
  }

  beforeAll(async () => {
    const created = await createTestDatabase("strict-input");
    db = created.db;
    close = created.close;
    const person = await db
      .insertInto("users")
      .values({ email: `strict-${suffix}@example.com`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    owner = person.id;
    const base = await insertBase(db, owner, { name: "Strict" });
    tableId = (
      await insertTable(db, owner, {
        baseId: base.id,
        name: "Figures",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "qty", label: "Qty", fieldType: "number" },
          { name: "body", label: "Body", fieldType: "long_text" },
        ],
      })
    ).id;
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    scope = await loadRowScope(
      db,
      { userId: owner, bindings: await loadBindings(db, owner) },
      table,
    );
    // The first account is an administrator, and a token needs its second
    // factor: the API is called by an editor of the base.
    const editor = await db
      .insertInto("users")
      .values({ email: `editor-${suffix}@example.com`, displayName: "Editor" })
      .returning("id")
      .executeTakeFirstOrThrow();
    editorId = editor.id;
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
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
    token = (await createApiToken(db, editor.id, "strict")).token;
    app = Fastify();
    await app.register(cookie);
    registerRestApi(app, {
      db,
      bus: recorder.bus,
      publicUrl: "http://localhost",
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  it("refuses a JSON integer past 2^53, and keeps the same one sent as text", async () => {
    const refused = await post(
      `{"records":[{"fields":{"name":"json","qty":${PAST_SAFE}}}]}`,
    );
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ code: string }>().code).toBe("invalid_cell");
    expect(await stored("json", "qty")).toBeUndefined();

    const cast = await post(
      `{"typecast":true,"records":[{"fields":{"name":"cast","qty":${PAST_SAFE}}}]}`,
    );
    expect(cast.statusCode, cast.body).toBe(400);
    expect(cast.json<{ code: string }>().code).toBe("invalid_cell");
    expect(await stored("cast", "qty")).toBeUndefined();

    const kept = await post(
      `{"records":[{"fields":{"name":"text","qty":"${PAST_SAFE}"}}]}`,
    );
    expect(kept.statusCode, kept.body).toBe(200);
    expect(await stored("text", "qty")).toBe(PAST_SAFE);
    const edge = await post(
      `{"records":[{"fields":{"name":"edge","qty":9007199254740991}}]}`,
    );
    expect(edge.statusCode, edge.body).toBe(200);
    expect(await stored("edge", "qty")).toBe("9007199254740991");
  });

  it("refuses it on a row's own write, as the app sends one", async () => {
    expect(
      await refusal(
        createRows(
          deps(),
          scope,
          [{ values: { name: "service", qty: Number(PAST_SAFE) } }],
          META,
        ),
      ),
    ).toBe("invalid_cell");
    const [id = ""] = await createRows(
      deps(),
      scope,
      [{ values: { name: "edited", qty: "1" } }],
      META,
    );
    expect(
      await refusal(
        updateRows(
          deps(),
          scope,
          [{ rowId: id, values: { qty: Number(PAST_SAFE) } }],
          META,
        ),
      ),
    ).toBe("invalid_cell");
    expect(await stored("edited", "qty")).toBe("1");
  });

  it("refuses by typecast what reads two ways, or does not fit", async () => {
    const twoWays = await post(
      `{"typecast":true,"records":[{"fields":{"name":"comma","qty":"1,234"}}]}`,
    );
    expect(twoWays.statusCode, twoWays.body).toBe(400);
    const long = await post(
      JSON.stringify({
        typecast: true,
        records: [{ fields: { name: "n".repeat(4_001) } }],
      }),
    );
    expect(long.statusCode, long.body).toBe(400);
    const fits = await post(
      JSON.stringify({
        typecast: true,
        records: [{ fields: { name: "limit", body: "b".repeat(20_000) } }],
      }),
    );
    expect(fits.statusCode, fits.body).toBe(200);
    expect(String(await stored("limit", "body"))).toHaveLength(20_000);
  });

  it("refuses on its line what an import would cut or guess", async () => {
    const result = await run(
      fileOf(
        ["Name", "Qty", "Body"],
        [
          ["fits", "1", "b".repeat(20_000)],
          ["n".repeat(4_001), "2", "x"],
          ["long", "3", "b".repeat(20_001)],
          ["twoWays", "1,234", "x"],
          ["plain", "12,5", "x"],
        ],
      ),
    );
    expect(result).toMatchObject({ inserted: 2, failed: 3 });
    expect(
      result.errors.map(({ line, column, code, detail }) => ({
        line,
        column,
        code,
        detail,
      })),
    ).toEqual([
      { line: 3, column: "Name", code: "value_too_long", detail: "4000" },
      { line: 4, column: "Body", code: "value_too_long", detail: "20000" },
      {
        line: 5,
        column: "Qty",
        code: "ambiguous_number",
        detail: undefined,
      },
    ]);
    expect(await stored("plain", "qty")).toBe("12.5");
    expect(await stored("twoWays", "qty")).toBeUndefined();
  });

  it("reads an import by the decimal mark it was told", async () => {
    const point = await run(fileOf(["Name", "Qty"], [["point", "1,234"]]), {
      decimalMark: ".",
    });
    expect(point.failed).toBe(0);
    expect(await stored("point", "qty")).toBe("1234");
    const comma = await run(fileOf(["Name", "Qty"], [["comma", "1,234"]]), {
      decimalMark: ",",
    });
    expect(comma.failed).toBe(0);
    expect(await stored("comma", "qty")).toBe("1.234");
  });

  it("refuses in an import told a comma what only a point could be", async () => {
    const result = await run(
      fileOf(
        ["Name", "Qty"],
        [
          ["dotted", "1.234"],
          ["short", "1.5"],
          ["long", "1.2345"],
          ["grouped", "1.234,5"],
        ],
      ),
      { decimalMark: "," },
    );
    expect(result).toMatchObject({ inserted: 3, failed: 1 });
    expect(result.errors).toMatchObject([
      { line: 2, column: "Qty", code: "ambiguous_point" },
    ]);
    expect(await stored("dotted", "qty")).toBeUndefined();
    expect(await stored("short", "qty")).toBe("1.5");
    expect(await stored("long", "qty")).toBe("1.2345");
    expect(await stored("grouped", "qty")).toBe("1234.5");
  });

  it("keeps the canonical point by typecast, where no language is declared", async () => {
    const kept = await post(
      `{"typecast":true,"records":[{"fields":{"name":"canon","qty":"1.234"}}]}`,
    );
    expect(kept.statusCode, kept.body).toBe(200);
    expect(await stored("canon", "qty")).toBe("1.234");
  });

  it("reads a date by its field, else what the import said, else refuses", async () => {
    const table = await datedTable();
    const mapping = ["name", "plain", "us", "eu"].map((column, source) => ({
      source,
      column,
    }));
    const importing = (rows: string[][], dayOrder?: "day-first") =>
      importIntoTable(db, {
        userId: owner,
        table,
        source: fileOf(["Name", "Plain", "Us", "Eu"], rows),
        mapping,
        addOptions: false,
        canManage: true,
        eventKey: `import:dates-${randomBytes(4).toString("hex")}`,
        ...(dayOrder ? { dayOrder } : {}),
      });
    const cell = async (name: string, column: string) => {
      const row = await db
        .selectFrom(table.physicalName as never)
        .select(sql<string>`${sql.ref(column)}::text`.as("v"))
        .where("name" as never, "=", name as never)
        .executeTakeFirst();
      return row?.v;
    };
    const unsaid = await importing([
      ["ambiguous", "03/04/2026", "", ""],
      ["clear", "13/04/2026", "", ""],
      ["same", "04/04/2026", "", ""],
      ["formats", "", "03/04/2026", "03/04/2026"],
    ]);
    expect(unsaid).toMatchObject({ inserted: 3, failed: 1 });
    expect(unsaid.errors).toMatchObject([
      { line: 2, column: "Plain", code: "ambiguous_date" },
    ]);
    expect(await cell("clear", "plain")).toBe("2026-04-13");
    expect(await cell("same", "plain")).toBe("2026-04-04");
    expect(await cell("formats", "us")).toBe("2026-03-04");
    expect(await cell("formats", "eu")).toBe("2026-04-03");
    const said = await importing(
      [["told", "03/04/2026", "03/04/2026", ""]],
      "day-first",
    );
    expect(said.failed).toBe(0);
    expect(await cell("told", "plain")).toBe("2026-04-03");
    // The field's own format wins over what the import said.
    expect(await cell("told", "us")).toBe("2026-03-04");
  });

  it("refuses by typecast a date that reads two ways, naming the format", async () => {
    const table = await datedTable();
    const send = (fields: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/api/v1/tables/${table.id}/records`,
        headers: { authorization: `Bearer ${token}` },
        payload: { typecast: true, records: [{ fields }] },
      });
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({
          userId: editorId,
          role: "editor",
          scope: "base",
          scopeId: table.baseId,
        })
        .execute(),
    );
    const refused = await send({ name: "two", plain: "03/04/2026" });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ code: string }>().code).toBe("ambiguous_date");
    for (const fields of [
      { name: "one", plain: "13/04/2026" },
      { name: "iso", plain: "2026-04-03" },
      { name: "us", us: "03/04/2026" },
    ]) {
      const answer = await send(fields);
      expect(answer.statusCode, answer.body).toBe(200);
    }
  });

  it("restores a number from history with every digit it had", async () => {
    const [id = ""] = await createRows(
      deps(),
      scope,
      [{ values: { name: "history", qty: PAST_SAFE } }],
      META,
    );
    await updateRows(
      deps(),
      scope,
      [{ rowId: id, values: { qty: "1" } }],
      META,
    );
    const events = await readAudit(db, tableId, id);
    const change = events.find((event) => event.action === "update");
    if (!change) throw new Error("no change");
    // What the history shows is the value it will put back.
    expect((change.oldValue as { qty: unknown }).qty).toBe(PAST_SAFE);
    await revertRow(deps(), scope, {
      recordId: id,
      eventId: change.id,
      field: "qty",
      seen: { qty: "1" },
    });
    expect(await stored("history", "qty")).toBe(PAST_SAFE);
  });

  it("restores a number with the scale it was stored with", async () => {
    const [id = ""] = await createRows(
      deps(),
      scope,
      [{ values: { name: "scaled", qty: "12.50" } }],
      META,
    );
    await updateRows(
      deps(),
      scope,
      [{ rowId: id, values: { qty: "1" } }],
      META,
    );
    const events = await readAudit(db, tableId, id);
    const change = events.find((event) => event.action === "update");
    if (!change) throw new Error("no change");
    await revertRow(deps(), scope, {
      recordId: id,
      eventId: change.id,
      field: "qty",
      seen: { qty: "1" },
    });
    expect(await stored("scaled", "qty")).toBe("12.50");
  });

  it("refuses to restore a number no write can hold, rather than round it", async () => {
    const digits = "1".repeat(70);
    const [id = ""] = await createRows(
      deps(),
      scope,
      [{ values: { name: "too-many", qty: "5" } }],
      META,
    );
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    await withAudit(db, { userId: owner, tableId, source: "web" }, (tx) =>
      sql`update ${sql.table(table.physicalName)} set qty = ${digits}::numeric where id = ${id}`.execute(
        tx,
      ),
    );
    await updateRows(
      deps(),
      scope,
      [{ rowId: id, values: { qty: "1" } }],
      META,
    );
    const events = await readAudit(db, tableId, id);
    const change = events.find(
      (event) => (event.newValue as { qty?: unknown } | null)?.qty === 1,
    );
    if (!change) throw new Error("no change");
    expect(
      await refusal(
        revertRow(deps(), scope, {
          recordId: id,
          eventId: change.id,
          field: "qty",
          seen: { qty: "1" },
        }),
      ),
    ).toBe("revert_not_exact");
    expect(await stored("too-many", "qty")).toBe("1");
  });

  it("gives large numbers their own group, under their exact key", async () => {
    await createRows(
      deps(),
      scope,
      [
        { values: { name: "g1", qty: "9007199254740992" } },
        { values: { name: "g2", qty: PAST_SAFE } },
      ],
      META,
    );
    const page = await readPage(
      db,
      scope.engine,
      {
        limit: 100,
        timeZone: "UTC",
        groupBy: [{ column: "qty", direction: "asc" }],
      },
      { total: false, groups: "starts" },
    );
    const keys = page.groups
      .filter((group) => group.depth === 1)
      .map((group) => group.keys[0]);
    expect(keys).toContain("9007199254740992");
    expect(keys).toContain(PAST_SAFE);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("writes a computed number's aggregates without trailing zeros", async () => {
    const base = await insertBase(db, owner, { name: "Computed" });
    const id = (
      await insertTable(db, owner, {
        baseId: base.id,
        name: "Halves",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "n", label: "N", fieldType: "number" },
          {
            name: "half",
            label: "Half",
            fieldType: "formula",
            formulaSource: "{N} / 2",
          },
        ],
      })
    ).id;
    const table = await findLiveTable(db, id);
    if (!table) throw new Error("no table");
    const halves = await loadRowScope(
      db,
      { userId: owner, bindings: await loadBindings(db, owner) },
      table,
    );
    await createRows(
      deps(),
      halves,
      ["0.5", "1", "1.5"].map((n) => ({ values: { n } })),
      META,
    );
    const figures = await aggregateRows(
      db,
      halves.engine,
      { timeZone: "UTC" },
      [
        { column: "half", fn: "sum" },
        { column: "half", fn: "avg" },
        { column: "half", fn: "min" },
        { column: "half", fn: "max" },
        { column: "half", fn: "median" },
      ],
    );
    expect(figures).toEqual(["1.5", "0.5", "0.25", "0.75", "0.5"]);
  });
});
