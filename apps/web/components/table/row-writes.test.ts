import { describe, expect, it } from "vitest";
import type { CatalogColumn, RowItem } from "../../lib/types";
import {
  lastInOrder,
  linkedIds,
  rowCopies,
  touchedFields,
  valuesBefore,
  valuesSeen,
  writeValues,
} from "./row-writes";

const columns = [
  { name: "name", fieldType: "text", kind: "text", access: "write" },
  { name: "tags", fieldType: "multi_select", kind: "text", access: "write" },
  { name: "total", fieldType: "formula", kind: "number", access: "write" },
] as unknown as CatalogColumn[];

const rows = [
  { id: "r1", name: "Alpha", tags: ["a"], total: 3 },
  { id: "r2", name: "Bravo", tags: [], total: 5 },
] as unknown as RowItem[];
const rowsById = new Map(rows.map((row) => [row.id, row]));

describe("writeValues", () => {
  it("writes each value as its field's type does, and nothing as null", () => {
    expect(
      writeValues(
        [{ rowId: "r1", values: { name: "Al", tags: ["x", "y"] } }],
        columns,
      ),
    ).toEqual([{ rowId: "r1", values: { name: "Al", tags: ["x", "y"] } }]);
    expect(
      writeValues(
        [{ rowId: "r1", values: { name: undefined as never } }],
        columns,
      ),
    ).toEqual([{ rowId: "r1", values: { name: null } }]);
  });
});

describe("touchedFields", () => {
  it("names each field changed once", () => {
    expect(
      touchedFields([
        { rowId: "r1", values: { name: "a", tags: [] } },
        { rowId: "r2", values: { name: "b" } },
      ]),
    ).toEqual(["name", "tags"]);
    expect(touchedFields([])).toEqual([]);
  });
});

describe("valuesBefore", () => {
  it("reads what each row holds in the fields changed", () => {
    expect(
      valuesBefore([{ rowId: "r1", values: { name: "Zed" } }], rowsById),
    ).toEqual([{ rowId: "r1", values: { name: "Alpha" } }]);
  });

  it("holds nothing for a row that is not read", () => {
    expect(
      valuesBefore([{ rowId: "r9", values: { name: "Zed" } }], rowsById),
    ).toEqual([{ rowId: "r9", values: { name: null } }]);
  });
});

describe("valuesSeen", () => {
  const typed = [
    ...columns,
    { name: "files", fieldType: "attachment", kind: "text", access: "write" },
    { name: "doc", fieldType: "json", kind: "text", access: "write" },
  ] as unknown as CatalogColumn[];

  it("takes what the page held, as each field writes it", () => {
    const seen = valuesSeen(
      [{ rowId: "r1", values: { files: ["k2"], doc: "{}" } }],
      [
        {
          rowId: "r1",
          values: {
            files: [{ key: "k1", name: "a.pdf" }],
            doc: { a: 1 },
          } as never,
        },
      ],
      typed,
    );
    expect(seen).toEqual([{ files: ["k1"], doc: '{"a":1}' }]);
  });

  it("takes what an editor showed when it opened over what the page holds", () => {
    const seen = valuesSeen(
      [{ rowId: "r1", values: { name: "Grace" }, seen: { name: "Ada" } }],
      [{ rowId: "r1", values: { name: "Edsger" } }],
      typed,
    );
    expect(seen).toEqual([{ name: "Ada" }]);
  });

  it("leaves out a value too long to travel", () => {
    const seen = valuesSeen(
      [{ rowId: "r1", values: { name: "short" } }],
      [{ rowId: "r1", values: { name: "x".repeat(20_001) } }],
      typed,
    );
    expect(seen).toEqual([{}]);
  });
});

describe("linkedIds", () => {
  it("lists the rows a link cell holds", () => {
    expect(linkedIds([{ id: "a", label: "A" }, { id: 7 }])).toEqual(["a", "7"]);
  });

  it("lists none for an empty cell, or a value that is not links", () => {
    expect(linkedIds(null)).toEqual([]);
    expect(linkedIds(["a", null, 3])).toEqual([]);
  });
});

describe("rowCopies", () => {
  it("copies the fields a person fills, and leaves computed ones", () => {
    expect(rowCopies(["r2", "r1"], rowsById, columns)).toEqual([
      { name: "Bravo", tags: [] },
      { name: "Alpha", tags: ["a"] },
    ]);
  });

  it("skips a row that is not read", () => {
    expect(rowCopies(["r9"], rowsById, columns)).toEqual([]);
  });
});

describe("lastInOrder", () => {
  it("is the row that comes last in the view, whatever order they were picked in", () => {
    expect(lastInOrder(["r2", "r1"], rows)).toBe("r2");
    expect(lastInOrder(["r1"], rows)).toBe("r1");
  });

  it("is nothing when no row is given", () => {
    expect(lastInOrder([], rows)).toBeUndefined();
  });
});
