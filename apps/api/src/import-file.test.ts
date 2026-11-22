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
  it("names blank headers in the importer's language, and numbers repeats", () => {
    expect(cleanHeaders(["Nom", "", "nom", "  Ville  "], "Champ")).toEqual([
      "Nom",
      "Champ 2",
      "nom (2)",
      "Ville",
    ]);
    expect(cleanHeaders(["", "Field 1"], "Field")).toEqual([
      "Field 1",
      "Field 1 (2)",
    ]);
  });

  it("finds a free name when a repeat meets a name already there", () => {
    expect(cleanHeaders(["a", "a (2)", "a"], "Field")).toEqual([
      "a",
      "a (2)",
      "a (3)",
    ]);
    expect(cleanHeaders(["a", "A", "a (2)"], "Field")).toEqual([
      "a",
      "A (2)",
      "a (2) (2)",
    ]);
  });

  it("keeps room for the counter in a name cut to 100", () => {
    const long = "x".repeat(150);
    const names = cleanHeaders([long, long, long], "Field");
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(100);
    expect(names[1]?.endsWith(" (2)")).toBe(true);
  });

  it("never cuts a character in two", () => {
    const names = cleanHeaders([`${"x".repeat(99)}🌍`], "Field");
    expect(names[0]).toBe("x".repeat(99));
  });
});

describe("the encoding of a text file", () => {
  it("reads UTF-8 and says so", async () => {
    const read = await readImport("csv", "nom\nHélène\n");
    expect(read.preview.encoding).toBe("utf-8");
    expect(read.shape.encoding).toBeUndefined();
    expect(cellsOf(read.rows)).toEqual([["Hélène"]]);
  });

  it("reads a character cut between two reads of the file", async () => {
    const lines = `${"x".repeat(999)}\n`.repeat(1048);
    const before = `nom\n${lines}${"y".repeat(570)}\n`;
    expect(Buffer.byteLength(before)).toBe(1024 * 1024 - 1);
    const read = await readImport("csv", `${before}éa\n`, { batch: 2000 });
    expect(read.preview.encoding).toBe("utf-8");
    expect(read.rows.at(-1)?.cells).toEqual(["éa"]);
  });

  it("reads Windows-1252, says so, and reads it the same way twice", async () => {
    const bytes = Buffer.from([
      ...Buffer.from("nom\nH\xe9l\xe8ne\n", "latin1"),
      0x80,
      0x20,
      0x92,
      0x0a,
    ]);
    const read = await readImport("csv", bytes);
    expect(read.preview.encoding).toBe("windows-1252");
    expect(read.shape.encoding).toBe("windows-1252");
    expect(read.preview.sample[0]).toEqual(["Hélène"]);
    expect(cellsOf(read.rows)).toEqual([["Hélène"], ["€ ’"]]);
  });

  it("refuses what no encoding reads for sure", async () => {
    const refused = [
      // A byte Windows-1252 does not define.
      Buffer.from([0x6e, 0x6f, 0x6d, 0x0a, 0xe9, 0x81, 0x0a]),
      // UTF-8 and something else in the same file.
      Buffer.concat([Buffer.from("nom\nHélène\n"), Buffer.from([0xe9, 0x0a])]),
      // UTF-16, both ways, and without its mark.
      Buffer.from("\uFEFFnom,ville\nx,y\n", "utf16le"),
      Buffer.from([0xfe, 0xff, 0x00, 0x6e, 0x00, 0x0a]),
      Buffer.from("nom,ville\nx,y\n", "utf16le"),
      // A workbook named .csv.
      await workbookBytes([["nom"], ["x"]]),
    ];
    for (const bytes of refused) {
      await expect(readImport("csv", bytes)).rejects.toMatchObject({
        code: "invalid_import",
      });
    }
  });

  it("refuses a NUL in the header of any format", async () => {
    await expect(readImport("csv", "a\0b,c\n1,2\n")).rejects.toMatchObject({
      code: "invalid_import",
    });
    await expect(readImport("json", '[{"a\\u0000b":1}]')).rejects.toMatchObject(
      { code: "invalid_import" },
    );
  });

  it("leaves a NUL in a row for that row to be refused", async () => {
    const read = await readImport("csv", "nom\nr1\nr\0 2\nr3\n");
    expect(cellsOf(read.rows)).toEqual([["r1"], ["r\0 2"], ["r3"]]);
  });

  it("reads a UTF-8 byte order mark", async () => {
    const read = await readImport("csv", "\uFEFFnom\nx\n");
    expect(read.shape.headers).toEqual(["nom"]);
    expect(read.preview.encoding).toBe("utf-8");
  });

  it("refuses a JSON file that is not UTF-8", async () => {
    await expect(
      readImport("json", Buffer.from('[{"a":"H\xe9l"}]', "latin1")),
    ).rejects.toMatchObject({ code: "invalid_import" });
  });
});

describe("the structure of a text file", () => {
  it("reads lines ended by a carriage return alone", async () => {
    const read = await readImport(
      "csv",
      "nom,ville\rDupont,Paris\rMartin,Lyon\r",
    );
    expect(read.shape.headers).toEqual(["nom", "ville"]);
    expect(cellsOf(read.rows)).toEqual([
      ["Dupont", "Paris"],
      ["Martin", "Lyon"],
    ]);
  });

  it("does not count a delimiter inside quotes", async () => {
    const read = await readImport("csv", '"a;b;c",d\n1,2\n');
    expect(read.shape.delimiter).toBe(",");
    expect(read.shape.headers).toEqual(["a;b;c", "d"]);
  });

  it("counts the cells a CSV export guarded, column by column", async () => {
    const read = await readImport("csv", "a,b\n'-1+1,x\n'=y,'plain\n");
    expect(read.preview.guarded).toEqual([2, 0]);
  });
});

describe("the numbers of a JSON file", () => {
  it("keeps each number as it is written", async () => {
    const read = await readImport(
      "json",
      '[{"a":12345678901234567890,"b":0.1234567890123456789,"c":1.50,"d":1e3}]',
    );
    expect(cellsOf(read.rows)).toEqual([
      ["12345678901234567890", "0.1234567890123456789", "1.50", "1e3"],
    ]);
    expect(read.rows[0]?.unreadable).toBeUndefined();
  });

  it("keeps them inside a list and an object", async () => {
    const read = await readImport(
      "json",
      '[{"l":[12345678901234567891,2],"o":{"n":12345678901234567892}}]',
    );
    expect(cellsOf(read.rows)).toEqual([
      ["12345678901234567891, 2", '{"n":12345678901234567892}'],
    ]);
  });

  it("marks a number past what a double holds, on its line, never Infinity", async () => {
    const read = await readImport(
      "json",
      '[{"a":1,"b":2},{"a":1e400,"b":3},{"a":[-1e999],"b":{"c":1E+400}}]',
    );
    expect(read.rows[0]?.unreadable).toBeUndefined();
    expect(read.rows[1]).toMatchObject({ line: 3, unreadable: [0] });
    expect(read.rows[2]).toMatchObject({ line: 4, unreadable: [0, 1] });
    expect(JSON.stringify(read.preview.sample)).not.toContain("Infinity");
    expect(cellsOf(read.rows)[1]).toEqual(["1e400", "3"]);
  });

  it("takes neither a number nor a list as a record", async () => {
    for (const text of ["[1]", "[[1]]", '{"records":[12]}', "12"]) {
      await expect(readImport("json", text)).rejects.toMatchObject({
        code: "invalid_import",
      });
    }
  });
});

describe("the records of a JSON file", () => {
  it("unwraps the records of a REST export", async () => {
    const read = await readImport(
      "json",
      '[{"id":"r1","createdTime":"2026-01-01","fields":{"a":1,"b":"x"}}]',
    );
    expect(read.shape.headers).toEqual(["a", "b"]);
    expect(cellsOf(read.rows)).toEqual([["1", "x"]]);
  });

  it("keeps every key of a record that only holds a key named fields", async () => {
    const read = await readImport(
      "json",
      '[{"id":7,"name":"alpha","fields":{"x":1}}]',
    );
    expect(read.shape.headers).toEqual(["id", "name", "fields"]);
    expect(cellsOf(read.rows)).toEqual([["7", "alpha", '{"x":1}']]);
  });

  it("keeps a key named fields that holds no object", async () => {
    const read = await readImport("json", '[{"id":7,"fields":3}]');
    expect(read.shape.headers).toEqual(["id", "fields"]);
    expect(cellsOf(read.rows)).toEqual([["7", "3"]]);
  });
});

describe("a formula with no stored value", () => {
  it("keeps its row, with the cell empty, and counts it", async () => {
    const bytes = await workbookBytes([
      ["a", "b"],
      ["x", "y"],
      [{ formula: "1+1" }, { formula: "2+2" }],
      ["z", { formula: "3+3", result: 6 }],
    ]);
    const read = await readImport("xlsx", bytes);
    expect(read.preview.total).toBe(3);
    expect(read.preview.emptyFormulas).toBe(2);
    expect(cellsOf(read.rows)).toEqual([
      ["x", "y"],
      ["", ""],
      ["z", "6"],
    ]);
    expect(read.rows[1]).toMatchObject({ line: 3, emptyFormulas: 2 });
    expect(read.rows[2]?.emptyFormulas).toBeUndefined();
  });

  it("counts one whose stored value is empty or an error", async () => {
    const bytes = await workbookBytes([
      ["a", "b"],
      [
        { formula: "1+1", result: "" },
        { formula: "1/0", result: { error: "#DIV/0!" } },
      ],
    ]);
    const read = await readImport("xlsx", bytes);
    expect(read.preview.total).toBe(1);
    expect(read.preview.emptyFormulas).toBe(2);
  });

  it("still leaves a row that is really blank out", async () => {
    const bytes = await workbookBytes([["a"], ["x"], [null], ["y"]]);
    const read = await readImport("xlsx", bytes);
    expect(read.preview.total).toBe(2);
    expect(read.preview.emptyFormulas).toBe(0);
  });

  it("counts them on each worksheet of a workbook", async () => {
    const bytes = await workbookBytes([["a"], [{ formula: "1+1" }]]);
    const sheets = await onDisk(bytes, (path) =>
      scanWorkbook(path, 100, "Field"),
    );
    expect(sheets[0]).toMatchObject({ emptyFormulas: 1, formulas: 1 });
    expect(sheets[0]?.shape.total).toBe(1);
  });
});

describe("the escapes of a workbook", () => {
  it("reads the characters XML cannot hold", () => {
    expect(excelText("c_x0001_d")).toBe("c\u0001d");
    expect(excelText("e_x000D_f")).toBe("e\rf");
  });

  it("leaves a text that only looks like one as it was written", () => {
    expect(excelText("_x005F_x0001_")).toBe("_x0001_");
    expect(excelText("_x12_ x0001_ _xZZZZ_")).toBe("_x12_ x0001_ _xZZZZ_");
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
      "Field 5",
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

  it("keeps a cell one character past the limit, to refuse it on its line", async () => {
    const over = "x".repeat(IMPORT_LIMITS.maxCell + 5_000);
    const atLimit = "y".repeat(IMPORT_LIMITS.maxCell);
    const { rows } = await readImport("csv", `A,B\n${over},${atLimit}\n`);
    expect(rows[0]?.cells[0]).toHaveLength(IMPORT_LIMITS.maxCell + 1);
    expect(rows[0]?.cells[1]).toHaveLength(IMPORT_LIMITS.maxCell);
    const sheet = await workbookBytes([["A"], [over]]);
    const read = await readImport("xlsx", sheet);
    expect(read.rows[0]?.cells[0]).toHaveLength(IMPORT_LIMITS.maxCell + 1);
    const json = JSON.stringify([{ A: over }]);
    const parsed = await readImport("json", json);
    expect(parsed.rows[0]?.cells[0]).toHaveLength(IMPORT_LIMITS.maxCell + 1);
  });

  it("says what the preview must ask: two readings, and the longest cell", async () => {
    const { preview } = await readImport(
      "csv",
      `A,B\n"1,234",short\n"12,5",${"z".repeat(4_001)}\n`,
    );
    expect(preview.ambiguousNumbers).toBe(1);
    expect(preview.longest).toEqual([5, 4_001]);
    expect(preview.inferred[0]?.fieldType).toBe("number");
  });

  it("counts a point that a decimal comma would read as thousands", async () => {
    const { preview } = await readImport(
      "csv",
      "A\n1.234\n1.5\n1.2345\n0.123\n",
    );
    expect(preview.ambiguousPoints).toBe(1);
    expect(preview.ambiguousNumbers).toBe(0);
  });

  it("counts the dates that read two ways, and only those", async () => {
    const { preview } = await readImport(
      "csv",
      "D\n03/04/2026\n13/04/2026\n04/04/2026\n2026-04-03\n",
    );
    expect(preview.ambiguousDates).toBe(1);
    expect(preview.inferred[0]?.fieldType).toBe("date");
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
      const sheets = await scanWorkbook(path, 1_000_000, "Field");
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
      onDisk(bytes, (path) => scanWorkbook(path, 2, "Field")),
    ).rejects.toThrow("Too many rows to import");
    const empty = await bookBytes([{ name: "Blank", rows: [] }]);
    await expect(
      onDisk(empty, (path) => scanWorkbook(path, 10, "Field")),
    ).rejects.toThrow("Invalid import");
    await expect(
      onDisk("not a workbook", (path) => scanWorkbook(path, 10, "Field")),
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
