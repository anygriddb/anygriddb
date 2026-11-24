/**
 * Freezes the page a native table returns for one sample of every writable
 * field type. A field-type definition refactor must leave these values
 * unchanged. Client-engine SQL for the same types is frozen in core's
 * `field-type-sql.freeze.test.ts`; the five-engine conformance suite pins
 * formula and physical-type behaviour separately.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CellValue } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeAttachment } from "../attachments.js";
import { loadBindings } from "../auth/access.js";
import { readPage } from "../data/rows.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { DiskStore } from "../files/index.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import {
  createRows,
  findLiveTable,
  loadRowScope,
  type RowScope,
} from "./rows.js";

const suffix = randomBytes(6).toString("hex");

const OPTIONS = [
  { name: "Open", color: "green" as const },
  { name: "Closed", color: "gray" as const },
];

describe("frozen page values per writable type (native)", () => {
  let database: Database;
  let close: (() => Promise<void>) | undefined;
  let scope: RowScope;
  let owner = "";
  let fileKey = "";
  const recorder = recordingBus();
  const deps = () => ({
    db: database,
    bus: recorder.bus,
    log: () => undefined,
  });

  beforeAll(async () => {
    const created = await createTestDatabase("field_type_freeze");
    database = created.db;
    close = created.close;
    const [person] = await database
      .insertInto("users")
      .values([{ email: `owner-${suffix}@example.com`, displayName: "Owner" }])
      .returning("id")
      .execute();
    owner = person?.id ?? "";
    const baseId = (await insertBase(database, owner, { name: "Freeze" })).id;
    const tableId = (
      await insertTable(database, owner, {
        baseId,
        name: "Types",
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "story", label: "Story", fieldType: "long_text" },
          { name: "amount", label: "Amount", fieldType: "number" },
          { name: "done", label: "Done", fieldType: "boolean" },
          { name: "day", label: "Day", fieldType: "date" },
          { name: "moment", label: "Moment", fieldType: "datetime" },
          {
            name: "state",
            label: "State",
            fieldType: "single_select",
            config: { options: OPTIONS },
          },
          {
            name: "tags",
            label: "Tags",
            fieldType: "multi_select",
            config: { options: OPTIONS },
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
      await mkdtemp(join(tmpdir(), "anygriddb-ft-freeze-")),
    );
    fileKey = (
      await storeAttachment(database, files, {
        tableId,
        userId: owner,
        filename: "note.txt",
        bytes: Buffer.from("note\n", "utf8"),
      })
    ).key;
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

  it("reads back the frozen sample for every writable type", async () => {
    const values: Record<string, CellValue> = {
      title: "Ada",
      story: "first\nline",
      amount: "7.25",
      done: true,
      day: "2026-02-28",
      moment: "2026-01-10T09:30:00.250Z",
      state: "Open",
      tags: ["Open", "Closed"],
      mail: "a@example.org",
      site: "https://example.org/path",
      call: "+33 1 23 45 67 89",
      tint: "#aabbcc",
      spot: "48.8566,2.3522",
      meta: '{"b":1,"a":2}',
      stars: 3,
      span: 3661,
      who: [owner],
      files: [fileKey],
    };
    const [rowId] = await createRows(deps(), scope, [{ values }], {
      source: "web",
    });
    expect(rowId).toBeTruthy();
    const page = await readPage(
      database,
      scope.engine,
      { limit: 10, timeZone: "UTC", rowIds: [rowId ?? ""] },
      { total: false },
    );
    expect(page.rows).toHaveLength(1);
    const row = page.rows[0] as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    const byName = Object.fromEntries(
      scope.engine.table.columns
        .filter((column) => column.name in values)
        .map((column) => [column.name, row?.[column.name]]),
    );
    // What a page returns for each type: keys of a document sorted, an
    // instant with its offset, and a file as its key alone on this read.
    expect(byName).toEqual({
      title: "Ada",
      story: "first\nline",
      amount: "7.25",
      done: true,
      day: "2026-02-28",
      moment: "2026-01-10T09:30:00.25+00:00",
      state: "Open",
      tags: ["Open", "Closed"],
      mail: "a@example.org",
      site: "https://example.org/path",
      call: "+33 1 23 45 67 89",
      tint: "#aabbcc",
      spot: "48.8566,2.3522",
      meta: '{"a": 2, "b": 1}',
      stars: 3,
      span: 3661,
      who: [owner],
      files: [fileKey],
    });
  });
});
