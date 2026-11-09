import type { EngineCatalog, EngineColumn } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  exportColumns,
  exportValue,
  renderExport,
  sheetName,
} from "./data-transfer.js";
import { parseImportFile } from "./import-file.js";

function column(name: string, label: string, fieldType: string): EngineColumn {
  return {
    id: name,
    name,
    label,
    fieldType,
    config: {},
  } as unknown as EngineColumn;
}

const name = column("nom", "Nom", "text");
const when = column("quand", "Quand", "date");
const owner = column("resp", "Responsable", "user");
const client = column("client", "Client", "relation_one_to_many");
const engine = {
  table: { columns: [name, when, owner, client] },
} as unknown as EngineCatalog;

describe("exportColumns", () => {
  it("follows the view order and leaves hidden columns out", () => {
    expect(
      exportColumns(engine, {
        fieldOrder: ["client", "nom"],
        hiddenFields: ["resp"],
      }).map((item) => item.name),
    ).toEqual(["client", "nom", "quand"]);
  });

  it("keeps every column without a view", () => {
    expect(exportColumns(engine, null)).toHaveLength(4);
  });
});

describe("exportValue", () => {
  const people = new Map([["u1", "Inès Martin"]]);

  it("shows people by name and links by label", () => {
    expect(exportValue(owner, ["u1", "u2"], people)).toEqual([
      "Inès Martin",
      "u2",
    ]);
    expect(exportValue(client, [{ id: "r1", label: "Acme" }], people)).toEqual([
      "Acme",
    ]);
  });

  it("keeps scalars and empty cells", () => {
    expect(exportValue(name, "Acme", people)).toBe("Acme");
    expect(exportValue(name, null, people)).toBeNull();
  });
});

describe("sheetName", () => {
  it("removes forbidden characters and clips to 31", () => {
    expect(sheetName("Budget [2026]: T1/T2")).toBe("Budget  2026   T1 T2");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(sheetName("***")).toBe("Export");
  });
});

describe("renderExport", () => {
  const rows = [
    {
      id: "a",
      nom: '=HYPERLINK("x")',
      quand: "2026-11-07",
      resp: ["u1"],
      client: [],
    },
    {
      id: "b",
      nom: "Boréal",
      quand: null,
      resp: null,
      client: [{ id: "r", label: "Acme" }],
    },
  ];
  const people = new Map([["u1", "Inès"]]);
  const columns = [name, when, owner, client];

  it("writes CSV with a byte order mark and guarded formulas", async () => {
    const text = (
      await renderExport("csv", "T", columns, rows, people)
    ).toString("utf8");
    expect(text.startsWith("\uFEFFNom,Quand,Responsable,Client\n")).toBe(true);
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("writes JSON keyed by label", async () => {
    const parsed = JSON.parse(
      (await renderExport("json", "T", columns, rows, people)).toString("utf8"),
    );
    expect(parsed[1]).toEqual({
      id: "b",
      Nom: "Boréal",
      Quand: null,
      Responsable: null,
      Client: ["Acme"],
    });
  });

  it("writes a workbook that imports back", async () => {
    const bytes = await renderExport("xlsx", "Clients", columns, rows, people);
    const sheet = await parseImportFile("xlsx", bytes);
    expect(sheet.headers).toEqual(["Nom", "Quand", "Responsable", "Client"]);
    expect(sheet.rows[0]).toEqual([
      '=HYPERLINK("x")',
      "2026-11-07",
      "Inès",
      "",
    ]);
    expect(sheet.rows[1]).toEqual(["Boréal", "", "", "Acme"]);
  });
});
