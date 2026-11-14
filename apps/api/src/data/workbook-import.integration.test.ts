/**
 * A workbook made a base (ADR 0078), against a real database: staged with
 * what its first pass found, then a table for each chosen sheet, its
 * fields typed from every row of its sheet, its rows read and written in
 * a worker as the job goes.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { madeNames } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiskStore } from "../files/index.js";
import { scanWorkbook } from "../import-file.js";
import { createTestDatabase } from "../test-database.js";
import { loadEngine } from "./engine.js";
import { readPage } from "./rows.js";
import {
  importWorkbook,
  loadStagedWorkbook,
  stageWorkbook,
  workbookBaseName,
} from "./workbook-import.js";

const suffix = randomBytes(6).toString("hex");

async function workbookFile(folder: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const clients = workbook.addWorksheet("Clients");
  clients.addRow(["Name", "Amount", "Since", "Stage"]);
  for (let index = 0; index < 600; index += 1) {
    clients.addRow([
      `Client ${index}`,
      index * 10,
      new Date(Date.UTC(2026, 0, 1 + (index % 28))),
      ["Lead", "Won", "Lost"][index % 3],
    ]);
  }
  workbook.addWorksheet("Empty");
  const notes = workbook.addWorksheet("Notes");
  notes.addRow(["Text"]);
  notes.addRow(["First"]);
  notes.addRow(["Second"]);
  const path = join(folder, "Ventes 2026.xlsx");
  await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()));
  return path;
}

describe("a workbook made a base", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let files: DiskStore;
  let owner = "";
  let other = "";
  let path = "";

  beforeAll(async () => {
    const created = await createTestDatabase("workbook_import");
    db = created.db;
    close = created.close;
    files = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-")));
    [owner, other] = (
      await db
        .insertInto("users")
        .values([
          { email: `owner-${suffix}@example.com`, displayName: "Owner" },
          { email: `other-${suffix}@example.com`, displayName: "Other" },
        ])
        .returning("id")
        .execute()
    ).map((row) => row.id) as [string, string];
    path = await workbookFile(
      await mkdtemp(join(tmpdir(), "anygriddb-workbook-test-")),
    );
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  async function staged() {
    return stageWorkbook(db, files, {
      userId: owner,
      filename: "Ventes 2026.xlsx",
      path,
      size: (await stat(path)).size,
      sheets: await scanWorkbook(path, 1_000_000),
    });
  }

  it("makes a table of each chosen sheet, typed from all its rows", async () => {
    const { importId, sheets } = await staged();
    expect(
      sheets.map((sheet) => [sheet.sheet, sheet.name, sheet.total]),
    ).toEqual([
      [0, "Clients", 600],
      [2, "Notes", 2],
    ]);
    const progress: number[] = [];
    const made = await importWorkbook(
      { db, files, maxRows: 1_000_000, names: madeNames("en") },
      {
        userId: owner,
        importId,
        name: workbookBaseName("Ventes 2026.xlsx"),
        sheets: [0, 2],
        eventKey: "test",
        onProgress: async (done) => {
          progress.push(done);
        },
      },
    );
    expect(made.report.sheets).toEqual([
      { name: "Clients", rows: 600, failed: 0, formulas: 0 },
      { name: "Notes", rows: 2, failed: 0, formulas: 0 },
    ]);
    expect(progress.at(-1)).toBe(602);
    const base = await db
      .selectFrom("bases")
      .select("name")
      .where("id", "=", made.baseId)
      .executeTakeFirstOrThrow();
    expect(base.name).toBe("Ventes 2026");
    const tables = await db
      .selectFrom("dataTables")
      .select(["id", "name"])
      .where("baseId", "=", made.baseId)
      .orderBy("position")
      .execute();
    expect(tables.map((table) => table.name)).toEqual(["Clients", "Notes"]);
    const clients = tables[0];
    if (!clients) throw new Error("no table");
    const { engine } = await loadEngine(db, clients.id, () => true);
    expect(
      engine.table.columns
        .filter((column) => !column.name.startsWith("ag_"))
        .map((column) => [column.label, column.fieldType]),
    ).toEqual(
      expect.arrayContaining([
        ["Name", "text"],
        ["Amount", "number"],
        ["Since", "date"],
        ["Stage", "single_select"],
      ]),
    );
    const page = await readPage(db, engine, { limit: 2 }, { total: true });
    expect(page.total).toBe(600);
    expect(page.rows[1]).toMatchObject({
      name: "Client 1",
      amount: "10",
      since: "2026-01-02",
      stage: "Won",
    });
  });

  it("refuses a sheet the workbook has not, and someone else's workbook", async () => {
    const { importId } = await staged();
    await expect(
      importWorkbook(
        { db, files, maxRows: 1_000_000, names: madeNames("en") },
        {
          userId: owner,
          importId,
          name: "Wrong",
          sheets: [1],
          eventKey: "test",
        },
      ),
    ).rejects.toThrow("Invalid mapping");
    expect(
      await db
        .selectFrom("bases")
        .select("id")
        .where("name", "=", "Wrong")
        .execute(),
    ).toEqual([]);
    await expect(loadStagedWorkbook(db, importId, other)).rejects.toThrow(
      "Unknown import",
    );
  });
});
