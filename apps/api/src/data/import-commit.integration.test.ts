/**
 * An import read from its file as it is written (ADR 0064): batches after
 * batches, the lines of the file in what it reports, options found before
 * the first row, and a key that finds a row this import wrote earlier.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportFormat } from "@anygriddb/core";
import ExcelJS from "exceljs";
import { readImportFile, scanImportFile } from "../import-file.js";
import { onDisk } from "../import-file.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import { importIntoTable, type ImportSource } from "./import-commit.js";
import { insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");

describe("an import read as it is written", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let baseId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("streamed-import");
    db = created.db;
    close = created.close;
    const person = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.com`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    owner = person.id;
    baseId = (await insertBase(db, owner, { name: "Imports" })).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  async function table(name: string) {
    const { id } = await insertTable(db, owner, {
      baseId,
      name,
      columns: [
        { label: "Code", fieldType: "text" },
        { label: "Qty", fieldType: "number" },
        {
          label: "Stage",
          fieldType: "single_select",
          config: { options: [{ name: "Open", color: "gray" }] },
        },
      ],
    });
    return db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  /** The file read from disk in batches of `batch`, as the job reads it. */
  function fileSource(path: string, batch: number) {
    return async (): Promise<ImportSource> => {
      const { shape } = await scanImportFile("csv", path, 1_000_000, "Field");
      return {
        headers: shape.headers,
        total: shape.total,
        batches: () => readImportFile(shape, path, batch, 1_000_000),
      };
    };
  }

  it("writes batch after batch, finds a key it wrote, and names the lines it refused", async () => {
    const target = await table("Stock");
    // 1,200 lines: K-7 again near the end, a blank line, and a bad number
    // past the second batch. Stages "Closed" and "Held" are not options yet.
    const lines = Array.from({ length: 1_200 }, (_, index) => {
      const n = index + 1;
      if (n === 1_100) return "K-7,99,Held";
      if (n === 600) return "";
      if (n === 1_050) return "K-1050,lots,Open";
      return `K-${n},${n},${n % 2 === 0 ? "Closed" : "open"}`;
    });
    const progress: Array<[number, number]> = [];
    const result = await onDisk(
      `Code,Qty,Stage,Note\n${lines.join("\n")}\n`,
      async (path) =>
        importIntoTable(db, {
          userId: owner,
          table: target,
          source: await fileSource(path, 500)(),
          mapping: [
            { source: 0, column: "code" },
            { source: 1, column: "qty" },
            { source: 2, column: "stage" },
            { source: 3, create: { label: "Note", fieldType: "text" } },
          ],
          upsertSource: 0,
          addOptions: true,
          canManage: true,
          eventKey: `import:stream-${suffix}`,
          onProgress: async (done, total) => {
            progress.push([done, total]);
          },
        }),
    );
    expect(result).toMatchObject({
      inserted: 1_197,
      updated: 1,
      failed: 1,
      createdColumns: 1,
    });
    // The header is line 1: line 1,051 of the file holds row 1,050.
    expect(result.errors).toEqual([
      { line: 1_051, column: "Qty", value: "lots", message: "Invalid value" },
    ]);
    expect(progress).toEqual([
      [0, 1_199],
      [500, 1_199],
      [1_000, 1_199],
      [1_199, 1_199],
    ]);
    const physical = target.physicalName;
    const rows = await db
      .selectFrom(physical as never)
      .select(["code" as never, "qty" as never, "stage" as never])
      .where("code" as never, "in", ["K-7", "K-8"] as never)
      .orderBy("code" as never)
      .execute();
    // The key written in the first batch was found again in the third.
    expect(rows).toEqual([
      { code: "K-7", qty: "99", stage: "Held" },
      { code: "K-8", qty: "8", stage: "Closed" },
    ]);
    const stage = await db
      .selectFrom("dataColumns")
      .select("config")
      .where("tableId", "=", target.id)
      .where("name", "=", "stage")
      .executeTakeFirstOrThrow();
    // Options found by reading the file once, before the first row: a
    // value in another case is the same option.
    expect(
      (stage.config as { options: Array<{ name: string }> }).options.map(
        (option) => option.name,
      ),
    ).toEqual(["Open", "Closed", "Held"]);
  });

  /** A whole file read by both passes and written into `target`. */
  async function importFile(
    target: Awaited<ReturnType<typeof table>>,
    format: ImportFormat,
    bytes: Buffer | string,
    options: {
      mapping: Parameters<typeof importIntoTable>[1]["mapping"];
      upsertSource?: number;
      stripTextGuard?: boolean;
      batch?: number;
    },
  ) {
    return onDisk(bytes, async (path) => {
      const { shape } = await scanImportFile(format, path, 1_000_000, "Field");
      return importIntoTable(db, {
        userId: owner,
        table: target,
        source: {
          headers: shape.headers,
          total: shape.total,
          batches: () =>
            readImportFile(shape, path, options.batch ?? 500, 1_000_000),
        },
        mapping: options.mapping,
        ...(options.upsertSource === undefined
          ? {}
          : { upsertSource: options.upsertSource }),
        ...(options.stripTextGuard ? { stripTextGuard: true } : {}),
        addOptions: true,
        canManage: true,
        eventKey: `import:faithful-${randomBytes(4).toString("hex")}`,
      });
    });
  }

  function stored(
    target: Awaited<ReturnType<typeof table>>,
    columns: readonly string[],
  ) {
    return db
      .selectFrom(target.physicalName as never)
      .select(columns as never)
      .orderBy("ag_created_at" as never)
      .orderBy("id" as never)
      .execute() as Promise<Array<Record<string, unknown>>>;
  }

  const CODE_QTY = [
    { source: 0, column: "code" },
    { source: 1, column: "qty" },
  ];

  it("refuses the line of a row deleted while it imports, and writes the others", async () => {
    const target = await table("Gone");
    const csv = (qty: number) =>
      `Code,Qty\n${Array.from({ length: 20 }, (_, index) => `g${String(index)},${String(qty)}`).join("\n")}\n`;
    await importFile(target, "csv", csv(1), { mapping: CODE_QTY });
    // The keys are read; then someone deletes one of the rows they found.
    const result = await onDisk(csv(2), async (path) =>
      importIntoTable(db, {
        userId: owner,
        table: target,
        source: await fileSource(path, 500)(),
        mapping: CODE_QTY,
        upsertSource: 0,
        addOptions: true,
        canManage: true,
        eventKey: `import:gone-${suffix}`,
        onProgress: async (done) => {
          if (done > 0) return;
          await withAudit(
            db,
            { userId: owner, tableId: target.id, source: "test" },
            (tx) =>
              sql`delete from ${sql.table(target.physicalName)} where code = 'g5'`.execute(
                tx,
              ),
          );
        },
      }),
    );
    expect(result).toMatchObject({ inserted: 0, updated: 19, failed: 1 });
    // The header is line 1: g5 is on line 7.
    expect(result.errors).toMatchObject([{ line: 7, code: "no_row" }]);
    expect(
      (await stored(target, ["code", "qty"])).map((row) => String(row.qty)),
    ).toEqual(Array.from({ length: 19 }, () => "2"));
  });

  it("refuses a NUL on its line and writes every other row", async () => {
    const target = await table("Nul");
    const lines = Array.from({ length: 1_500 }, (_, index) =>
      index === 699 ? "r\0x,1" : `r${index},1`,
    );
    const result = await importFile(
      target,
      "csv",
      `Code,Qty\n${lines.join("\n")}\n`,
      { mapping: CODE_QTY },
    );
    expect(result).toMatchObject({ inserted: 1_499, failed: 1 });
    expect(result.errors).toEqual([
      {
        line: 701,
        column: "Code",
        value: "r\u2400x",
        message: "Invalid value",
      },
    ]);
    expect(await stored(target, ["code"])).toHaveLength(1_499);
  });

  it("refuses a NUL in a list's value without losing the import", async () => {
    const target = await table("NulOption");
    const result = await importFile(
      target,
      "csv",
      "Code,Stage\nA,Open\nB,Bad\0\nC,New\n",
      {
        mapping: [
          { source: 0, column: "code" },
          { source: 1, column: "stage" },
        ],
      },
    );
    expect(result).toMatchObject({ inserted: 2, failed: 1 });
    expect(result.errors[0]?.line).toBe(3);
  });

  it("refuses a document that spells a NUL on its line", async () => {
    const { id } = await insertTable(db, owner, {
      baseId,
      name: "Documents",
      columns: [{ label: "Doc", fieldType: "json" }],
    });
    const target = await db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const result = await importFile(
      target,
      "json",
      '[{"Doc":{"a":1}},{"Doc":{"a":"x\\u0000"}},{"Doc":{"a":2}}]',
      { mapping: [{ source: 0, column: "doc" }] },
    );
    expect(result).toMatchObject({ inserted: 2, failed: 1 });
    expect(result.errors[0]?.line).toBe(3);
  });

  it("writes Windows-1252 and UTF-8 alike, with no replacement mark", async () => {
    const cp1252 = await table("Cp1252");
    const utf8 = await table("Utf8");
    const mapping = [{ source: 0, column: "code" }];
    await importFile(
      cp1252,
      "csv",
      Buffer.from("Code\nH\xe9l\xe8ne\n", "latin1"),
      { mapping },
    );
    await importFile(utf8, "csv", "Code\nHélène\n", { mapping });
    expect(await stored(cp1252, ["code"])).toEqual([{ code: "Hélène" }]);
    expect(await stored(utf8, ["code"])).toEqual([{ code: "Hélène" }]);
  });

  it("keeps a JSON number exact and refuses one past a double on its line", async () => {
    const target = await table("Exact");
    const result = await importFile(
      target,
      "json",
      '[{"Code":12345678901234567890,"Qty":12345678901234567890},' +
        '{"Code":"b","Qty":0.1234567890123456789},' +
        '{"Code":1e400,"Qty":1},{"Code":"d","Qty":1e400}]',
      { mapping: CODE_QTY },
    );
    expect(result).toMatchObject({ inserted: 2, failed: 2 });
    expect(result.errors.map((error) => error.line)).toEqual([4, 5]);
    const rows = await stored(target, ["code", "qty"]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { code: "12345678901234567890", qty: "12345678901234567890" },
        { code: "b", qty: "0.1234567890123456789" },
      ]),
    );
  });

  it("says which lines a repeated key replaced, in a batch and across two", async () => {
    const target = await table("Repeats");
    const lines = ["A,100", "B,5", "A,200", "C,1", "C,2", "A,300"];
    const result = await importFile(
      target,
      "csv",
      `Code,Qty\n${lines.join("\n")}\n`,
      { mapping: CODE_QTY, upsertSource: 0, batch: 2 },
    );
    expect(result).toMatchObject({ failed: 0, replaced: 3 });
    expect(result.replacedLines).toEqual([
      { line: 2, by: 4, key: "A" },
      { line: 5, by: 6, key: "C" },
      { line: 4, by: 7, key: "A" },
    ]);
    const rows = await stored(target, ["code", "qty"]);
    const qty = (code: string) => rows.find((row) => row.code === code)?.qty;
    expect(qty("A")).toBe("300");
    expect(qty("C")).toBe("2");
    expect(qty("B")).toBe("5");
  });

  it("reports nothing replaced when no key repeats", async () => {
    const target = await table("NoRepeat");
    const result = await importFile(target, "csv", "Code,Qty\nA,1\nB,2\n", {
      mapping: CODE_QTY,
      upsertSource: 0,
    });
    expect(result).toMatchObject({ replaced: 0, replacedLines: [] });
  });

  it("takes off an export's apostrophe in checked fields, and in a text only when told", async () => {
    const file = "Code,Qty\n'-reste,'-5\n";
    const kept = await table("GuardKept");
    await importFile(kept, "csv", file, { mapping: CODE_QTY });
    expect(await stored(kept, ["code", "qty"])).toEqual([
      { code: "'-reste", qty: "-5" },
    ]);
    const stripped = await table("GuardStripped");
    await importFile(stripped, "csv", file, {
      mapping: CODE_QTY,
      stripTextGuard: true,
    });
    expect(await stored(stripped, ["code", "qty"])).toEqual([
      { code: "-reste", qty: "-5" },
    ]);
  });

  it("reads an option an export guarded, and adds no option with its apostrophe", async () => {
    const target = await table("GuardOption");
    const result = await importFile(
      target,
      "csv",
      "Code,Stage\nA,'-late\nB,'-late\n",
      {
        mapping: [
          { source: 0, column: "code" },
          { source: 1, column: "stage" },
        ],
      },
    );
    expect(result).toMatchObject({ inserted: 2, failed: 0 });
    expect(await stored(target, ["stage"])).toEqual([
      { stage: "-late" },
      { stage: "-late" },
    ]);
  });

  it("counts a formula with no stored value, and keeps its row", async () => {
    const target = await table("Formulas");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("S");
    sheet.addRow(["Code", "Qty"]);
    sheet.addRow(["A", 1]);
    sheet.addRow([{ formula: "1+1" }, { formula: "2+2" }]);
    const result = await importFile(
      target,
      "xlsx",
      Buffer.from(await workbook.xlsx.writeBuffer()),
      { mapping: CODE_QTY },
    );
    expect(result).toMatchObject({ inserted: 2, failed: 0, emptyFormulas: 2 });
    const rows = await stored(target, ["code", "qty"]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { code: "A", qty: "1" },
        { code: null, qty: null },
      ]),
    );
  });

  it("takes a JSON list as its items, an option holding a comma kept whole", async () => {
    const { id } = await insertTable(db, owner, {
      baseId,
      name: "Marks",
      columns: [
        { label: "K", fieldType: "text" },
        {
          label: "M",
          fieldType: "multi_select",
          config: {
            options: ["one", "a,b", "semi;colon"].map((name) => ({
              name,
              color: "gray",
            })),
          },
        },
      ],
    });
    const target = await db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const file = JSON.stringify([
      { K: "plain", M: ["one"] },
      { K: "comma", M: ["one", "a,b"] },
      { K: "semi", M: ["semi;colon"] },
      { K: "new", M: ["fresh, two"] },
    ]);
    const result = await importFile(target, "json", file, {
      mapping: [
        { source: 0, column: "k" },
        { source: 1, column: "m" },
      ],
    });
    expect(result).toMatchObject({ inserted: 4, failed: 0 });
    const rows = await stored(target, ["k", "m"]);
    expect(Object.fromEntries(rows.map((row) => [row.k, row.m]))).toEqual({
      plain: ["one"],
      comma: ["one", "a,b"],
      semi: ["semi;colon"],
      new: ["fresh, two"],
    });
    const { config } = await db
      .selectFrom("dataColumns")
      .select("config")
      .where("tableId", "=", id)
      .where("name", "=", "m")
      .executeTakeFirstOrThrow();
    // One option added, as the file wrote it, and none made of its pieces.
    expect(
      (config as { options: Array<{ name: string }> }).options.map(
        (option) => option.name,
      ),
    ).toEqual(["one", "a,b", "semi;colon", "fresh, two"]);
  });

  it("says what was committed before a failure", async () => {
    const target = await table("Stopped");
    const written: Array<{ inserted: number; updated: number }> = [];
    async function* stopping() {
      await Promise.resolve();
      yield [{ line: 2, cells: ["A", "1"] }];
      throw new Error("the disk went away");
    }
    await expect(
      importIntoTable(db, {
        userId: owner,
        table: target,
        source: {
          headers: ["Code", "Qty"],
          total: 2,
          batches: stopping,
        },
        mapping: CODE_QTY,
        addOptions: true,
        canManage: true,
        eventKey: `import:stopped-${suffix}`,
        onWritten: (counts) => written.push(counts),
      }),
    ).rejects.toThrow("the disk went away");
    expect(written.at(-1)).toEqual({ inserted: 1, updated: 0 });
  });
});
