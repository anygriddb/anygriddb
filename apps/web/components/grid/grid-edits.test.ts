import { describe, expect, it } from "vitest";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { clearUpdates, fillDownUpdates, fillSeriesUpdates } from "./grid-edits";

const columns = [
  { name: "name", fieldType: "text", kind: "text", access: "write" },
  { name: "amount", fieldType: "number", kind: "number", access: "write" },
  { name: "total", fieldType: "formula", kind: "number", access: "write" },
] as unknown as CatalogColumn[];

const rows = [
  { id: "r1", name: "One", amount: "1", total: 1 },
  { id: "r2", name: "Two", amount: "2", total: 2 },
  { id: "r3", name: "Three", amount: "30", total: 30 },
  { id: "r4", name: "Four", amount: "40", total: 40 },
] as unknown as RowItem[];

describe("clearUpdates", () => {
  it("empties the fields a person fills, in every row of the range", () => {
    expect(clearUpdates(rows.slice(0, 2), columns)).toEqual([
      { rowId: "r1", values: { name: null, amount: null } },
      { rowId: "r2", values: { name: null, amount: null } },
    ]);
  });

  it("writes nothing when the range holds only computed fields", () => {
    expect(clearUpdates(rows, columns.slice(2))).toEqual([]);
  });
});

describe("fillDownUpdates", () => {
  it("copies the first row's values to the rows under it", () => {
    expect(fillDownUpdates(rows.slice(0, 3), columns.slice(0, 1))).toEqual([
      { rowId: "r2", values: { name: "One" } },
      { rowId: "r3", values: { name: "One" } },
    ]);
  });

  it("skips a row not read yet, and copies nothing without a first row", () => {
    expect(
      fillDownUpdates([rows[0], undefined, rows[2]], columns.slice(0, 1)),
    ).toEqual([{ rowId: "r3", values: { name: "One" } }]);
    expect(fillDownUpdates([undefined, rows[1]], columns)).toEqual([]);
  });
});

describe("fillSeriesUpdates", () => {
  it("carries a series of numbers on, and repeats texts", () => {
    expect(fillSeriesUpdates(rows.slice(0, 2), rows.slice(2), columns)).toEqual(
      [
        { rowId: "r3", values: { name: "One", amount: "3" } },
        { rowId: "r4", values: { name: "Two", amount: "4" } },
      ],
    );
  });

  it("skips a row not read yet, keeping the series' place", () => {
    expect(
      fillSeriesUpdates(rows.slice(0, 2), [undefined, rows[3]], columns),
    ).toEqual([{ rowId: "r4", values: { name: "Two", amount: "4" } }]);
  });
});
