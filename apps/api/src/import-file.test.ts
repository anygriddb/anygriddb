import fs from "node:fs";
import { Writable } from "node:stream";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import {
  cleanHeaders,
  detectImportFormat,
  excelText,
  IMPORT_LIMITS,
  maxImportBytes,
  readImportFile,
  scanWorkbook,
  type SheetRow,
} from "./import-file.js";
import { cellsOf, onDisk, readImport } from "./import-file.test-helpers.js";

async function workbookBytes(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Données");
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("detectImportFormat", () => {
  it("reads the extension", () => {
    expect(detectImportFormat("Clients.CSV")).toBe("csv");
    expect(detectImportFormat("export.tsv")).toBe("tsv");
    expect(detectImportFormat("dump.json")).toBe("json");
    expect(detectImportFormat("budget.xlsx")).toBe("xlsx");
  });

  it("rejects other files", () => {
    expect(() => detectImportFormat("macro.xlsm")).toThrow("Invalid import");
    expect(() => detectImportFormat("noextension")).toThrow("Invalid import");
  });
});

describe("cleanHeaders", () => {
  it("names blank headers and numbers repeats", () => {
    expect(cleanHeaders(["Nom", "", "nom", "  Ville  "])).toEqual([
      "Nom",
      "Colonne 2",
      "nom (2)",
      "Ville",
    ]);
  });
});

describe("reading an import file", () => {
  it("reads CSV with a byte order mark, pads short rows, and keeps each line", async () => {
    const read = await readImport(
      "csv",
      '\uFEFFNom;Ville\nAcme;Lyon\n\n"Bor\néal"\nSète;Agde\n',
    );
    expect(read.shape).toMatchObject({
      headers: ["Nom", "Ville"],
      delimiter: ";",
      headerLine: 1,
      total: 3,
    });
    // A blank line counts, a quoted line break does not.
    expect(read.rows).toEqual([
      { line: 2, cells: ["Acme", "Lyon"] },
      { line: 4, cells: ["Bor\néal", ""] },
      { line: 5, cells: ["Sète", "Agde"] },
    ]);
  });

  it("reads TSV, and a file cut anywhere into batches", async () => {
    const lines = Array.from({ length: 7 }, (_, i) => `${i}\tv${i}`);
    const read = await readImport("tsv", `a\tb\n${lines.join("\n")}`, {
      batch: 3,
    });
    expect(read.rows).toHaveLength(7);
    expect(read.rows.at(-1)).toEqual({ line: 8, cells: ["6", "v6"] });
  });

  it("reads JSON arrays, wrapped records, and REST records", async () => {
    const plain = await readImport(
      "json",
      JSON.stringify([
        { nom: "Acme", tags: ["a", "b"], n: 3 },
        {},
        { ville: "Sète" },
      ]),
    );
    expect(plain.shape.headers).toEqual(["nom", "tags", "n", "ville"]);
    expect(plain.rows).toEqual([
      { line: 2, cells: ["Acme", "a, b", "3", ""] },
      { line: 4, cells: ["", "", "", "Sète"] },
    ]);
    const wrapped = await readImport(
      "json",
      JSON.stringify({ records: [{ id: "x", fields: { nom: "Acme" } }] }),
    );
    expect(wrapped.shape.headers).toEqual(["nom"]);
  });

  it("refuses malformed JSON and non-object rows", async () => {
    for (const text of ["{nope", "[1,2]", '{"a":1}']) {
      await expect(readImport("json", text)).rejects.toThrow("Invalid import");
    }
  });

  it("reads the first worksheet of a workbook, numbered as the sheet is", async () => {
    const bytes = await workbookBytes([
      [],
      ["Nom", "Date", "Montant", "Actif"],
      ["Acme", new Date(Date.UTC(2026, 10, 7)), 12.5, true],
      [],
      [
        { richText: [{ text: "Bo" }, { text: "réal" }] },
        new Date(Date.UTC(2026, 10, 7, 14, 30)),
        { formula: "C2*2", result: 25 },
        false,
        "sans titre",
      ],
    ]);
    const read = await readImport("xlsx", bytes);
    expect(read.shape).toMatchObject({ headerLine: 2, total: 2 });
    // A value under no header gets a column of its own.
    expect(read.shape.headers).toEqual([
      "Nom",
      "Date",
      "Montant",
      "Actif",
      "Colonne 5",
    ]);
    expect(read.rows).toEqual([
      { line: 3, cells: ["Acme", "2026-11-07", "12.5", "true", ""] },
      {
        line: 5,
        cells: [
          "Boréal",
          "2026-11-07T14:30:00.000Z",
          "25",
          "false",
          "sans titre",
        ],
      },
    ]);
  });

  it("reads a workbook whose sheet is cached while the rest of it is unzipped", async () => {
    // The sheet comes before the shared strings and the workbook part, so
    // the reader writes it to a temporary file first. A slow disk lets the
    // unzipper reach the end of the archive meanwhile; no part may be lost.
    const createWriteStream = fs.createWriteStream;
    const slow = vi
      .spyOn(fs, "createWriteStream")
      .mockImplementation((...args: Parameters<typeof createWriteStream>) => {
        const file = createWriteStream(...args);
        return new Writable({
          write: (chunk, encoding, done) => file.write(chunk, encoding, done),
          final: (done) => {
            setTimeout(() => file.end(done), 50);
          },
        }) as fs.WriteStream;
      });
    try {
      const bytes = await workbookBytes([
        ["Nom", "Ville"],
        ["Boréal", "Lyon"],
      ]);
      const read = await readImport("xlsx", bytes);
      expect(slow).toHaveBeenCalled();
      expect(read.shape.headers).toEqual(["Nom", "Ville"]);
      expect(cellsOf(read.rows)).toEqual([["Boréal", "Lyon"]]);
    } finally {
      slow.mockRestore();
    }
  });

  it("refuses bytes that are not a workbook, empty files, and too many columns", async () => {
    await expect(readImport("xlsx", "not a zip")).rejects.toThrow(
      "Invalid import",
    );
    await expect(readImport("csv", "")).rejects.toThrow("Invalid import");
    const wide = Array.from(
      { length: IMPORT_LIMITS.maxColumns + 1 },
      (_, i) => `c${i}`,
    ).join(",");
    await expect(readImport("csv", `${wide}\n`)).rejects.toThrow(
      "Invalid import",
    );
    // A row wider than its header, with something in the extra cell.
    await expect(readImport("csv", "a,b\n1,2,3\n")).rejects.toThrow(
      "Invalid import",
    );
  });

  it("stops at the row ceiling, and keeps a sample and inferred types", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => `${i},texte ${i}`);
    const text = `n,t\n${rows.join("\n")}\n`;
    await expect(readImport("csv", text, { maxRows: 29 })).rejects.toThrow(
      "Too many rows to import",
    );
    const read = await readImport("csv", text, { maxRows: 30 });
    expect(read.preview.total).toBe(30);
    expect(read.preview.sample).toHaveLength(20);
    expect(read.preview.inferred.map((field) => field.fieldType)).toEqual([
      "number",
      "text",
    ]);
  });

  it("takes larger text files than spreadsheets or JSON", () => {
    expect(maxImportBytes("csv")).toBeGreaterThan(maxImportBytes("xlsx"));
    expect(maxImportBytes("xlsx")).toBeGreaterThan(maxImportBytes("json"));
  });
});

describe("a workbook made a base", () => {
  async function bookBytes(
    sheets: ReadonlyArray<{ name: string; rows: unknown[][]; hidden?: true }>,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    for (const sheet of sheets) {
      const added = workbook.addWorksheet(
        sheet.name,
        sheet.hidden ? { state: "hidden" } : {},
      );
      for (const row of sheet.rows) added.addRow(row);
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  it("finds each sheet that holds a header, and the types all its rows fit", async () => {
    const clients: unknown[][] = Array.from({ length: 300 }, (_, index) => [
      `Client ${index}`,
      index,
      index % 2 === 0 ? "Open" : "Done",
    ]);
    // Past the rows a sample keeps: the amounts are not all numbers.
    clients.push(["Last", "not a number", "Open"]);
    const bytes = await bookBytes([
      { name: "Clients", rows: [["Name", "Amount", "Status"], ...clients] },
      { name: "Empty", rows: [] },
      {
        name: "Notes",
        rows: [
          ["Text", "Twice"],
          ["ab", { formula: "A2&A2", result: "abab" }],
        ],
        hidden: true,
      },
    ]);
    await onDisk(bytes, async (path) => {
      const sheets = await scanWorkbook(path, 1_000_000);
      expect(
        sheets.map((sheet) => [
          sheet.sheet,
          sheet.name,
          sheet.hidden,
          sheet.shape.total,
          sheet.formulas,
        ]),
      ).toEqual([
        [0, "Clients", false, 301, 0],
        [2, "Notes", true, 1, 1],
      ]);
      expect(
        sheets[0]?.preview.inferred.map((field) => field.fieldType),
      ).toEqual(["text", "text", "single_select"]);
      // The second pass reads a sheet by its place in the file.
      const notes = sheets[1];
      if (!notes) throw new Error("no sheet");
      const rows: SheetRow[] = [];
      for await (const batch of readImportFile(notes.shape, path, 10, 10)) {
        rows.push(...batch);
      }
      expect(rows).toEqual([{ line: 2, cells: ["ab", "abab"] }]);
    });
  });

  it("refuses a workbook past its rows, one without a header, and other bytes", async () => {
    const bytes = await bookBytes([
      { name: "One", rows: [["A"], ["1"], ["2"]] },
      { name: "Two", rows: [["B"], ["3"]] },
    ]);
    // Three rows in all, past two.
    await expect(
      onDisk(bytes, (path) => scanWorkbook(path, 2)),
    ).rejects.toThrow("Too many rows to import");
    const empty = await bookBytes([{ name: "Blank", rows: [] }]);
    await expect(
      onDisk(empty, (path) => scanWorkbook(path, 10)),
    ).rejects.toThrow("Invalid import");
    await expect(
      onDisk("not a workbook", (path) => scanWorkbook(path, 10)),
    ).rejects.toThrow("Invalid import");
  });
});

describe("excelText", () => {
  it("reads hyperlinks, errors, and empty cells", () => {
    expect(excelText({ text: "site", hyperlink: "https://a.example" })).toBe(
      "site",
    );
    expect(excelText({ error: "#DIV/0!" })).toBe("");
    expect(excelText(null)).toBe("");
  });
});
