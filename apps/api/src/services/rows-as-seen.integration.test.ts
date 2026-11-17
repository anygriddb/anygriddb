/**
 * A write to one of AnyGridDB's own tables, compared with what its author
 * saw (ADR 0103), against a real database.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, type CellValue } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeAttachment } from "../attachments.js";
import { loadBindings } from "../auth/access.js";
import { readByIds } from "../data/rows.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { DiskStore } from "../files/index.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import {
  createRows,
  findLiveTable,
  loadRowScope,
  updateRows,
  type RowScope,
} from "./rows.js";

const suffix = randomBytes(6).toString("hex");

describe("a write compared with what its author saw", () => {
  let database: Database;
  let close: (() => Promise<void>) | undefined;
  let scope: RowScope;
  let owner = "";
  let fileA = "";
  let fileB = "";
  const recorder = recordingBus();
  const deps = () => ({
    db: database,
    bus: recorder.bus,
    log: () => undefined,
  });

  /** The row as a page reads it, then as it travels to a browser. */
  async function read(rowId: string): Promise<Record<string, unknown>> {
    const [row] = await readByIds(database, scope.engine, [rowId], "UTC");
    if (!row) throw new Error("no row");
    return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  }

  async function code(write: Promise<unknown>): Promise<string> {
    try {
      await write;
    } catch (error) {
      if (error instanceof AppError) return error.code;
      throw error;
    }
    return "written";
  }

  beforeAll(async () => {
    const created = await createTestDatabase("rows_as_seen");
    database = created.db;
    close = created.close;
    const [person] = await database
      .insertInto("users")
      .values([{ email: `owner-${suffix}@example.com`, displayName: "Owner" }])
      .returning("id")
      .execute();
    owner = person?.id ?? "";
    const baseId = (await insertBase(database, owner, { name: "Seen" })).id;
    const options = [
      { name: "Open", color: "green" },
      { name: "Closed", color: "gray" },
    ];
    const tableId = (
      await insertTable(database, owner, {
        baseId,
        name: "Things",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "story", label: "Story", fieldType: "long_text" },
          { name: "amount", label: "Amount", fieldType: "number" },
          { name: "done", label: "Done", fieldType: "boolean" },
          { name: "day", label: "Day", fieldType: "date" },
          { name: "moment", label: "Moment", fieldType: "datetime" },
          {
            name: "state",
            label: "State",
            fieldType: "single_select",
            config: { options },
          },
          {
            name: "tags",
            label: "Tags",
            fieldType: "multi_select",
            config: { options },
          },
          { name: "mail", label: "Mail", fieldType: "email" },
          { name: "site", label: "Site", fieldType: "url" },
          { name: "call", label: "Call", fieldType: "phone" },
          { name: "tint", label: "Tint", fieldType: "color" },
          { name: "spot", label: "Spot", fieldType: "place" },
          { name: "meta", label: "Meta", fieldType: "json" },
          { name: "stars", label: "Stars", fieldType: "rating" },
          { name: "span", label: "Span", fieldType: "duration" },
          {
            name: "who",
            label: "Who",
            fieldType: "user",
            config: { multiple: true },
          },
          { name: "files", label: "Files", fieldType: "attachment" },
        ],
      })
    ).id;
    const files = new DiskStore(
      await mkdtemp(join(tmpdir(), "anygriddb-seen-")),
    );
    const store = (filename: string) =>
      storeAttachment(database, files, {
        tableId,
        userId: owner,
        filename,
        bytes: Buffer.from(`${filename}\n`, "utf8"),
      });
    fileA = (await store("a.txt")).key;
    fileB = (await store("b.txt")).key;
    const table = await findLiveTable(database, tableId);
    if (!table) throw new Error("no table");
    scope = await loadRowScope(
      database,
      { userId: owner, bindings: await loadBindings(database, owner) },
      table,
    );
  });

  afterAll(async () => {
    await close?.();
  });

  async function add(values: Record<string, CellValue>): Promise<string> {
    const [id] = await createRows(deps(), scope, [{ values }], {
      source: "web",
    });
    if (!id) throw new Error("no row made");
    return id;
  }

  it("refuses a change to a value that moved since its author read it", async () => {
    const rowId = await add({ name: "Ada", story: "first" });
    const seen = await read(rowId);
    // Someone else changes the name meanwhile.
    await updateRows(deps(), scope, [{ rowId, values: { name: "Grace" } }], {
      source: "web",
    });
    let refused: unknown;
    try {
      await updateRows(
        deps(),
        scope,
        [
          {
            rowId,
            values: { name: "Edsger" },
            expected: { name: seen.name as CellValue },
          },
        ],
        { source: "web" },
      );
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).code).toBe("row_conflict");
    // The message names the field by its label.
    expect((refused as AppError).detail).toBe("Name");
    expect((await read(rowId)).name).toBe("Grace");
  });

  it("writes a change to one field while another moved", async () => {
    const rowId = await add({ name: "Ada", story: "first" });
    const seen = await read(rowId);
    await updateRows(deps(), scope, [{ rowId, values: { story: "second" } }], {
      source: "web",
    });
    const written = await code(
      updateRows(
        deps(),
        scope,
        [
          {
            rowId,
            values: { name: "Edsger" },
            // What was seen in a field that is not written is not compared.
            expected: {
              name: seen.name as CellValue,
              story: seen.story as CellValue,
            },
          },
        ],
        { source: "web" },
      ),
    );
    expect(written).toBe("written");
    const now = await read(rowId);
    expect(now.name).toBe("Edsger");
    expect(now.story).toBe("second");
  });

  it("writes a change that does not say what its author saw", async () => {
    const rowId = await add({ name: "Ada" });
    await updateRows(deps(), scope, [{ rowId, values: { name: "Grace" } }], {
      source: "web",
    });
    const written = await code(
      updateRows(deps(), scope, [{ rowId, values: { name: "Edsger" } }], {
        source: "api",
      }),
    );
    expect(written).toBe("written");
    expect((await read(rowId)).name).toBe("Edsger");
  });

  it("writes nothing of a batch when one of its rows moved", async () => {
    const first = await add({ name: "One" });
    const second = await add({ name: "Two" });
    await updateRows(
      deps(),
      scope,
      [{ rowId: second, values: { name: "Moved" } }],
      { source: "web" },
    );
    const refused = await code(
      updateRows(
        deps(),
        scope,
        [
          { rowId: first, values: { name: "1" }, expected: { name: "One" } },
          { rowId: second, values: { name: "2" }, expected: { name: "Two" } },
        ],
        { source: "web" },
      ),
    );
    expect(refused).toBe("row_conflict");
    expect((await read(first)).name).toBe("One");
    expect((await read(second)).name).toBe("Moved");
  });

  it("takes every kind of field as it was read, then as it was just written", async () => {
    const before: Record<string, CellValue> = {
      name: "Ada",
      story: "line one\nline two",
      amount: "12.50",
      done: true,
      day: "2026-01-05",
      moment: "2026-01-05T10:30:00.000Z",
      state: "Open",
      tags: ["Open", "Closed"],
      mail: "ada@example.com",
      site: "https://example.com/a",
      call: "+33 1 23 45 67 89",
      tint: "#1f3fae",
      spot: "48.8566,2.3522",
      meta: '{"b":[1,2],"a":{"c":true}}',
      stars: 3,
      span: 5400,
      who: [owner],
      files: [fileA],
    };
    const after: Record<string, CellValue> = {
      name: "Grace",
      story: "other",
      amount: "13",
      done: false,
      day: "2026-02-06",
      moment: "2026-02-06T08:00:00.000Z",
      state: "Closed",
      tags: ["Closed"],
      mail: "grace@example.com",
      site: "https://example.com/b",
      call: "+33 9 87 65 43 21",
      tint: "#c00000",
      spot: "45.764,4.8357",
      meta: '{"a":1}',
      stars: 5,
      span: 60,
      who: [],
      files: [fileA, fileB],
    };
    const blank: Record<string, CellValue> = Object.fromEntries(
      Object.keys(before).map((name) => [name, null]),
    );
    for (const name of Object.keys(before)) {
      const rowId = await add({ [name]: before[name] ?? null });
      // As a page read it: a file as its key, name and size, a document
      // as an object, a number as the engine spells it.
      const asRead = (await read(rowId))[name];
      const first = await code(
        updateRows(
          deps(),
          scope,
          [
            {
              rowId,
              values: { [name]: after[name] ?? null },
              expected: { [name]: asRead as CellValue },
            },
          ],
          { source: "web" },
        ),
      );
      expect(first, `${name}, as read`).toBe("written");
      // As the page holds it until it reads the row again: the value it
      // just wrote, in the form it sent.
      const second = await code(
        updateRows(
          deps(),
          scope,
          [
            {
              rowId,
              values: { [name]: blank[name] ?? null },
              expected: { [name]: after[name] ?? null },
            },
          ],
          { source: "web" },
        ),
      );
      expect(second, `${name}, as just written`).toBe("written");
      // And from an empty cell, which a page may hold as nothing at all.
      const third = await code(
        updateRows(
          deps(),
          scope,
          [
            {
              rowId,
              values: { [name]: before[name] ?? null },
              expected: { [name]: null },
            },
          ],
          { source: "web" },
        ),
      );
      expect(third, `${name}, from empty`).toBe("written");
      // What it held first is no longer what it holds: refused.
      const stale = await code(
        updateRows(
          deps(),
          scope,
          [
            {
              rowId,
              values: { [name]: after[name] ?? null },
              expected: { [name]: after[name] ?? null },
            },
          ],
          { source: "web" },
        ),
      );
      expect(stale, `${name}, stale`).toBe("row_conflict");
    }
  });
});
