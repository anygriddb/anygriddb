import { describe, expect, it } from "vitest";
import type { CatalogColumn, RowItem } from "../../lib/types";
import {
  type GridItem,
  groupLevels,
  hasStarts,
  layoutFromRows,
  layoutFromStarts,
  positionOf,
  readPrefix,
  viewItems,
} from "./group-layout";

const levels = [
  {
    column: "status",
    colorOf: (label: string) => (label === "Done" ? "green" : undefined),
  },
  { column: "owner" },
];

/** Two levels over 250 rows: Done (200: Ann 150, Bob 50), To do (50: Ann). */
const groups = [
  { keys: ["Done", null], depth: 1, count: 200, start: 0 },
  { keys: ["Done", "Ann"], depth: 2, count: 150, start: 0 },
  { keys: ["Done", "Bob"], depth: 2, count: 50, start: 150 },
  { keys: ["To do", null], depth: 1, count: 50, start: 200 },
  { keys: ["To do", "Ann"], depth: 2, count: 50, start: 200 },
];

const headers = (items: GridItem[]) =>
  items.flatMap((item) =>
    item.type === "group" ? [[item.depth, item.label, item.count]] : [],
  );
const rowIndexes = (items: GridItem[]) =>
  items.flatMap((item) => (item.type === "row" ? [item.index] : []));

describe("a grouped grid laid out from where its groups start", () => {
  it("places every row of the view under its header, before any is read", () => {
    // Listed out of order: the layout follows the starts.
    const items = layoutFromStarts(
      groups.toReversed(),
      levels,
      new Set(),
      2000,
    );
    expect(headers(items)).toEqual([
      [0, "Done", 200],
      [1, "Ann", 150],
      [1, "Bob", 50],
      [0, "To do", 50],
      [1, "Ann", 50],
    ]);
    expect(rowIndexes(items)).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(items[0]).toMatchObject({ type: "group", color: "green" });
    // The second header sits right after its parent, the rows after it.
    expect(items[2]).toEqual({ type: "row", index: 0 });
    expect(items.at(-1)).toEqual({ type: "row", index: 249 });
  });

  it("skips a folded group's rows and inner headers, and keeps its own", () => {
    const folded = new Set(["Done"]);
    const items = layoutFromStarts(groups, levels, folded, 2000);
    expect(headers(items)).toEqual([
      [0, "Done", 200],
      [0, "To do", 50],
      [1, "Ann", 50],
    ]);
    expect(rowIndexes(items)).toEqual(
      Array.from({ length: 50 }, (_, i) => 200 + i),
    );
    const inner = layoutFromStarts(
      groups,
      levels,
      new Set(["Done\u0000Bob"]),
      2000,
    );
    expect(rowIndexes(inner)).not.toContain(150);
    expect(rowIndexes(inner)).toContain(149);
    expect(rowIndexes(inner)).toContain(200);
  });

  it("stops where the read stopped counting groups, and says so", () => {
    const items = layoutFromStarts(groups, levels, new Set(), 5);
    // The last group named (To do, Ann) may be cut: rows from it are left out.
    expect(headers(items)).toEqual([
      [0, "Done", 200],
      [1, "Ann", 150],
      [1, "Bob", 50],
    ]);
    expect(rowIndexes(items).at(-1)).toBe(199);
    expect(items.at(-1)).toEqual({ type: "limit" });
  });

  it("is not used when a group's start is missing", () => {
    expect(hasStarts(groups)).toBe(true);
    expect(hasStarts([])).toBe(false);
    expect(hasStarts([{ keys: ["Done"], depth: 1, count: 2 }, ...groups])).toBe(
      false,
    );
  });
});

describe("a grouped grid laid out from the rows read so far", () => {
  const row = (status: string | null, owner: string) =>
    ({ id: `${status}-${owner}`, status, owner }) as unknown as RowItem;

  it("puts a header where a value changes, counted as the read counted it", () => {
    const rows = [row("Done", "Ann"), row("Done", "Bob"), row(null, "Ann")];
    const items = layoutFromRows(rows, levels, new Set(), [
      { keys: ["Done", null], depth: 1, count: 200 },
    ]);
    expect(headers(items)).toEqual([
      [0, "Done", 200],
      [1, "Ann", 1],
      [1, "Bob", 1],
      [0, "", 1],
      [1, "Ann", 1],
    ]);
    expect(rowIndexes(items)).toEqual([0, 1, 2]);
  });

  it("hides the rows of a folded group", () => {
    const rows = [row("Done", "Ann"), row("To do", "Ann")];
    const items = layoutFromRows(rows, levels, new Set(["Done"]), []);
    expect(rowIndexes(items)).toEqual([1]);
  });
});

describe("a row's place among the rows shown", () => {
  it("finds it, and says -1 for a row in a folded group", () => {
    expect(positionOf([0, 1, 2, 200, 201], 200)).toBe(3);
    expect(positionOf([0, 1, 2, 200, 201], 150)).toBe(-1);
    expect(positionOf([], 0)).toBe(-1);
  });
});

describe("what a view of rows draws", () => {
  const nothing = new Set<string>();

  it("draws every row, then the line that adds one, when nothing groups", () => {
    const items = viewItems({
      total: 3,
      levels: [],
      groups: [],
      readSoFar: [],
      collapsed: nothing,
      canAdd: true,
    });
    expect(items).toEqual([
      { type: "row", index: 0 },
      { type: "row", index: 1 },
      { type: "row", index: 2 },
      { type: "add" },
    ]);
    // A reader adds nothing.
    expect(
      viewItems({
        total: 1,
        levels: [],
        groups: [],
        readSoFar: [],
        collapsed: nothing,
        canAdd: false,
      }),
    ).toEqual([{ type: "row", index: 0 }]);
  });

  it("draws the headers where the read says groups start, or from the rows read", () => {
    const placed = viewItems({
      total: 250,
      levels,
      groups,
      readSoFar: [],
      collapsed: new Set(["To do"]),
      canAdd: false,
    });
    expect(headers(placed)).toEqual([
      [0, "Done", 200],
      [1, "Ann", 150],
      [1, "Bob", 50],
      [0, "To do", 50],
    ]);
    expect(rowIndexes(placed)).toHaveLength(200);
    const read = [
      { id: "a", status: "Done", owner: "Ann" },
      { id: "b", status: "To do", owner: "Ann" },
    ] as unknown as RowItem[];
    const fromRows = viewItems({
      total: 2,
      levels: levels.slice(0, 1),
      groups: [],
      readSoFar: read,
      collapsed: nothing,
      canAdd: true,
    });
    expect(headers(fromRows)).toEqual([
      [0, "Done", 1],
      [0, "To do", 1],
    ]);
    expect(fromRows.at(-1)).toEqual({ type: "add" });
  });

  it("colours a choice field's headers by its options, and nothing else", () => {
    const columns = [
      {
        name: "status",
        label: "Status",
        fieldType: "single_select",
        config: { options: [{ name: "Done", color: "green" }] },
      },
      { name: "owner", label: "Owner", fieldType: "text" },
    ] as CatalogColumn[];
    const [status, owner] = groupLevels(
      [{ column: "status" }, { column: "owner" }],
      columns,
    );
    expect(status?.colorOf?.("Done")).toBe("green");
    expect(status?.colorOf?.("Unknown")).toBeUndefined();
    expect(owner).toEqual({ column: "owner" });
  });

  it("reads the rows from the first one until one is not read yet", () => {
    const rows = [{ id: "a" }, { id: "b" }, undefined, { id: "d" }];
    expect(
      readPrefix((index) => rows[index] as RowItem | undefined).map(
        (row) => row.id,
      ),
    ).toEqual(["a", "b"]);
    expect(readPrefix(() => undefined)).toEqual([]);
  });
});
