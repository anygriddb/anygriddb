import type { ColumnRow, RelationRow, TableRow } from "@anygriddb/db";
import { describe, expect, it, vi } from "vitest";
import {
  assembleEngine,
  indexCatalog,
  lookupCatalog,
  type CatalogRows,
} from "./engine.js";

const table = (index: number) =>
  ({
    id: `t${String(index)}`,
    baseId: "b",
    storage: "native",
    physicalName: `tbl_${String(index)}`,
    sourceId: null,
  }) as unknown as TableRow;

let serial = 0;
const nextId = () => {
  serial += 1;
  return `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`;
};

const column = (
  tableId: string,
  name: string,
  position: number,
  fieldType = "text",
  config: unknown = {},
) =>
  ({
    id: nextId(),
    tableId,
    name,
    label: name,
    physicalName: name,
    fieldType,
    config,
    position,
    isPrimary: position === 0,
    externalType: null,
  }) as unknown as ColumnRow;

/** Tables that each link to the next, with the way back. */
function catalog(size: number): CatalogRows {
  const tables = Array.from({ length: size }, (_, index) => table(index));
  const columns: ColumnRow[] = [];
  const relations: RelationRow[] = [];
  tables.forEach((item, index) => {
    columns.push(column(item.id, "title", 0));
    const next = tables[index + 1];
    if (!next) return;
    const forward = column(item.id, "next", 1, "relation_one_to_many");
    const back = column(next.id, "back", 2, "relation_one_to_many", {
      inverseOf: forward.id,
    });
    columns.push(forward, back);
    relations.push(
      {
        fromColumnId: forward.id,
        toTableId: next.id,
        kind: "one_to_many",
        junctionName: null,
        inverseColumnId: back.id,
      } as unknown as RelationRow,
      {
        fromColumnId: back.id,
        toTableId: item.id,
        kind: "one_to_many",
        junctionName: null,
        inverseColumnId: forward.id,
      } as unknown as RelationRow,
    );
  });
  return { tables, columns, relations, sources: new Map() };
}

describe("a catalog read for many tables", () => {
  it("builds each table once, however many engines it serves", () => {
    const rows = catalog(200);
    const scans = [
      vi.spyOn(rows.columns, "filter"),
      vi.spyOn(rows.columns, "find"),
      vi.spyOn(rows.relations, "find"),
      vi.spyOn(rows.tables, "find"),
    ];
    const index = indexCatalog(rows);
    const engines = rows.tables.map((item) =>
      assembleEngine(item.id, rows, () => true, index),
    );
    for (const scan of scans) expect(scan).not.toHaveBeenCalled();
    expect(index.engineTables.size).toBe(200);
    expect(new Set(engines.map((engine) => engine.tables)).size).toBe(1);
  });

  it("gives each table its columns in order and its links both ways", () => {
    const rows = catalog(3);
    rows.columns.reverse();
    const engine = assembleEngine("t1", rows, () => true, indexCatalog(rows));
    expect(engine.table.columns.map((item) => item.name)).toEqual([
      "title",
      "next",
      "back",
    ]);
    expect(engine.table.primaryColumn).toBe("title");
    expect(engine.table.columns[1]?.relation).toEqual({
      kind: "one_to_many",
      direction: "forward",
      targetTableId: "t2",
      fkColumn: "next",
    });
    expect(engine.table.columns[2]?.relation).toEqual({
      kind: "one_to_many",
      direction: "inverse",
      targetTableId: "t0",
      fkColumn: "next",
    });
  });

  it("gives the same engine with or without a shared index", () => {
    const rows = catalog(5);
    const shared = indexCatalog(rows);
    for (const item of rows.tables) {
      const alone = assembleEngine(item.id, rows, () => true);
      const built = assembleEngine(item.id, rows, () => true, shared);
      expect(built.table).toEqual(alone.table);
      expect([...built.tables.keys()]).toEqual([...alone.tables.keys()]);
    }
  });

  it("refuses a table the catalog does not hold", () => {
    const rows = catalog(2);
    expect(() =>
      assembleEngine("elsewhere", rows, () => true, indexCatalog(rows)),
    ).toThrow(expect.objectContaining({ code: "unknown_table" }));
  });

  it("keeps the first of two rows under one id, as a search would", () => {
    const rows = catalog(2);
    const [first] = rows.relations;
    if (!first) throw new Error("no relation");
    rows.relations.push({ ...first, toTableId: "other" });
    expect(lookupCatalog(rows).relations.get(first.fromColumnId)).toBe(first);
  });
});
