import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EngineCatalog,
  EngineColumn,
  ExportFormat,
} from "@anygriddb/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  exportColumns,
  exportValue,
  exportWriter,
  sheetName,
} from "./data-transfer.js";
import type { RowRecord } from "./data/rows.js";
import { cellsOf, readImport } from "./import-file.test-helpers.js";

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

describe("exportWriter", () => {
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
  ] as unknown as RowRecord[];
  const people = new Map([["u1", "Inès"]]);
  const columns = [name, when, owner, client];
  const folder = mkdtemp(join(tmpdir(), "anygriddb-export-test-"));
  afterAll(async () => {
    await rm(await folder, { recursive: true, force: true });
  });

  /** Writes the rows a page at a time, as a job does, and reads the file. */
  async function written(
    format: ExportFormat,
    pages: readonly (readonly RowRecord[])[],
  ): Promise<Buffer> {
    const path = join(await folder, `${String(Math.random())}.${format}`);
    const writer = exportWriter(format, path, "Clients", columns, people);
    for (const page of pages) await writer.add(page);
    const size = await writer.finish();
    const bytes = await readFile(path);
    expect(bytes.length).toBe(size);
    return bytes;
  }

  it("writes CSV with a byte order mark and guarded formulas", async () => {
    const text = (
      await written("csv", [rows.slice(0, 1), [], rows.slice(1)])
    ).toString("utf8");
    expect(text.startsWith("\uFEFFNom,Quand,Responsable,Client\n")).toBe(true);
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text.split("\n")).toHaveLength(3);
  });

  it("writes JSON keyed by label, as one array laid out whole", async () => {
    const text = (
      await written("json", [rows.slice(0, 1), rows.slice(1)])
    ).toString("utf8");
    const parsed = JSON.parse(text) as unknown[];
    expect(parsed[1]).toEqual({
      id: "b",
      Nom: "Boréal",
      Quand: null,
      Responsable: null,
      Client: ["Acme"],
    });
    expect(text).toBe(JSON.stringify(parsed, null, 2));
  });

  it("writes an empty file that still reads", async () => {
    expect((await written("json", [])).toString("utf8")).toBe("[]");
    expect((await written("csv", [])).toString("utf8")).toBe(
      "\uFEFFNom,Quand,Responsable,Client",
    );
  });

  async function writtenOne(
    format: ExportFormat,
    only: readonly EngineColumn[],
    row: Record<string, unknown>,
  ): Promise<Buffer> {
    const path = join(await folder, `${String(Math.random())}.${format}`);
    const writer = exportWriter(format, path, "Clients", only, people);
    await writer.add([{ id: "r", ...row }]);
    await writer.finish();
    return readFile(path);
  }

  it("keeps U+2028 and U+2029 in JSON, adding no space in a value", async () => {
    const text = (
      await writtenOne("json", [name], { nom: "x\u2028y\u2029z" })
    ).toString("utf8");
    const parsed = JSON.parse(text) as Array<{ Nom: string }>;
    expect(parsed[0]?.Nom).toBe("x\u2028y\u2029z");
    expect(text).toBe(JSON.stringify(parsed, null, 2));
  });

  it("writes a negative number bare in CSV, and imports it back equal", async () => {
    const amount = column("amount", "Amount", "number");
    const bytes = await writtenOne("csv", [amount], { amount: "-1250.50" });
    expect(bytes.toString("utf8")).toBe("\uFEFFAmount\n-1250.50");
    expect(cellsOf((await readImport("csv", bytes)).rows)).toEqual([
      ["-1250.50"],
    ]);
  });

  it("gives a workbook back every character a text holds", async () => {
    for (const value of [
      "c\u0001d",
      "e\rf",
      "g\r\nh",
      "i\u007fj",
      "tab\there\nline",
      "_x0001_ stays written",
      "_x005F_x0001_ too",
      "\uFFFE and \uFFFF",
    ]) {
      const bytes = await writtenOne("xlsx", [name], { nom: value });
      expect(cellsOf((await readImport("xlsx", bytes)).rows)).toEqual([
        [value],
      ]);
    }
  });

  it("keeps a date-time's microseconds, as text", async () => {
    const at = column("at", "At", "datetime");
    for (const value of [
      "2026-06-15T12:00:00.123456Z",
      "2026-06-15T12:00:00.000001+00:00",
    ]) {
      const bytes = await writtenOne("xlsx", [at], { at: value });
      expect(cellsOf((await readImport("xlsx", bytes)).rows)).toEqual([
        [value],
      ]);
    }
  });

  it("still writes a date-time of whole milliseconds as a date", async () => {
    const at = column("at", "At", "datetime");
    const bytes = await writtenOne("xlsx", [at], {
      at: "2026-06-15T12:00:00.123000Z",
    });
    expect(cellsOf((await readImport("xlsx", bytes)).rows)).toEqual([
      ["2026-06-15T12:00:00.123Z"],
    ]);
  });

  it("writes a workbook that imports back", async () => {
    const bytes = await written("xlsx", [rows.slice(0, 1), rows.slice(1)]);
    const read = await readImport("xlsx", bytes);
    expect(read.shape.headers).toEqual([
      "Nom",
      "Quand",
      "Responsable",
      "Client",
    ]);
    const imported = cellsOf(read.rows);
    expect(imported[0]).toEqual(['=HYPERLINK("x")', "2026-11-07", "Inès", ""]);
    expect(imported[1]).toEqual(["Boréal", "", "", "Acme"]);
  });
});
