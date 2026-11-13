/**
 * An import read from its file as it is written (ADR 0064): batches after
 * batches, the lines of the file in what it reports, options found before
 * the first row, and a key that finds a row this import wrote earlier.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readImportFile, scanImportFile } from "../import-file.js";
import { onDisk } from "../import-file.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
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
      const { shape } = await scanImportFile("csv", path, 1_000_000);
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
});
