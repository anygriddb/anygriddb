import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  cleanHeaders,
  detectImportFormat,
  excelText,
  IMPORT_LIMITS,
  parseImportFile,
  previewSheet,
} from "./import-file.js";

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

describe("parseImportFile", () => {
  it("parses CSV with a byte order mark and pads short rows", async () => {
    const sheet = await parseImportFile(
      "csv",
      Buffer.from("\uFEFFNom;Ville\nAcme;Lyon\nBoréal\n\n"),
    );
    expect(sheet.headers).toEqual(["Nom", "Ville"]);
    expect(sheet.rows).toEqual([
      ["Acme", "Lyon"],
      ["Boréal", ""],
    ]);
  });

  it("parses TSV", async () => {
    const sheet = await parseImportFile("tsv", Buffer.from("a\tb\n1\t2\n"));
    expect(sheet.rows).toEqual([["1", "2"]]);
  });

  it("parses JSON arrays, wrapped records, and REST records", async () => {
    const plain = await parseImportFile(
      "json",
      Buffer.from(
        JSON.stringify([
          { nom: "Acme", tags: ["a", "b"], n: 3 },
          { ville: "Sète" },
        ]),
      ),
    );
    expect(plain.headers).toEqual(["nom", "tags", "n", "ville"]);
    expect(plain.rows).toEqual([
      ["Acme", "a, b", "3", ""],
      ["", "", "", "Sète"],
    ]);
    const wrapped = await parseImportFile(
      "json",
      Buffer.from(
        JSON.stringify({ records: [{ id: "x", fields: { nom: "Acme" } }] }),
      ),
    );
    expect(wrapped.headers).toEqual(["nom"]);
  });

  it("rejects malformed JSON and non-object rows", async () => {
    await expect(parseImportFile("json", Buffer.from("{nope"))).rejects.toThrow(
      "Invalid import",
    );
    await expect(parseImportFile("json", Buffer.from("[1,2]"))).rejects.toThrow(
      "Invalid import",
    );
    await expect(
      parseImportFile("json", Buffer.from('{"a":1}')),
    ).rejects.toThrow("Invalid import");
  });

  it("parses the first worksheet of a workbook", async () => {
    const bytes = await workbookBytes([
      ["Nom", "Date", "Montant", "Actif"],
      ["Acme", new Date(Date.UTC(2026, 10, 7)), 12.5, true],
      [
        { richText: [{ text: "Bo" }, { text: "réal" }] },
        new Date(Date.UTC(2026, 10, 7, 14, 30)),
        { formula: "C2*2", result: 25 },
        false,
      ],
    ]);
    const sheet = await parseImportFile("xlsx", bytes);
    expect(sheet.headers).toEqual(["Nom", "Date", "Montant", "Actif"]);
    expect(sheet.rows).toEqual([
      ["Acme", "2026-11-07", "12.5", "true"],
      ["Boréal", "2026-11-07T14:30:00.000Z", "25", "false"],
    ]);
  });

  it("rejects bytes that are not a workbook", async () => {
    await expect(
      parseImportFile("xlsx", Buffer.from("not a zip")),
    ).rejects.toThrow("Invalid import");
  });

  it("rejects empty files and too many columns", async () => {
    await expect(parseImportFile("csv", Buffer.alloc(0))).rejects.toThrow(
      "Invalid import",
    );
    const wide = Array.from(
      { length: IMPORT_LIMITS.maxColumns + 1 },
      (_, i) => `c${i}`,
    ).join(",");
    await expect(
      parseImportFile("csv", Buffer.from(`${wide}\n`)),
    ).rejects.toThrow();
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

describe("previewSheet", () => {
  it("returns a sample and inferred types", () => {
    const preview = previewSheet({
      headers: ["n", "t"],
      rows: Array.from({ length: 30 }, (_, i) => [String(i), `texte ${i}`]),
    });
    expect(preview.total).toBe(30);
    expect(preview.sample).toHaveLength(20);
    expect(preview.inferred.map((field) => field.fieldType)).toEqual([
      "number",
      "text",
    ]);
  });
});
