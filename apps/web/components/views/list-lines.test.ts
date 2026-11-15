import { describe, expect, it } from "vitest";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { listLines, parentColumn, parentColumns } from "./list-lines";

const TABLE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const link = (
  name: string,
  targetTableId: string,
  direction: "forward" | "inverse" = "forward",
  fieldType = "relation_one_to_many",
) =>
  ({
    name,
    fieldType,
    relation: { targetTableId, direction },
  }) as unknown as CatalogColumn;

/** A row, and the row its `parent` link names. */
const row = (id: string, parent?: string) =>
  ({
    id,
    parent: parent ? [{ id: parent, label: parent }] : [],
  }) as unknown as RowItem;

const drawn = (lines: ReturnType<typeof listLines>) =>
  lines.map(
    (line) =>
      `${"  ".repeat(line.level - 1)}${line.row.id}${line.children > 0 ? (line.folded ? " +" : " -") : ""}`,
  );

describe("parentColumns", () => {
  const columns = [
    {
      name: "name",
      fieldType: "text",
      relation: null,
    } as unknown as CatalogColumn,
    link("parent", TABLE),
    link("children", TABLE, "inverse"),
    link("client", OTHER),
    link("related", TABLE, "forward", "relation_many_to_many"),
    link("manager", TABLE),
  ];

  it("keeps the links to one row of the same table that a row holds itself", () => {
    expect(parentColumns(columns, TABLE).map((column) => column.name)).toEqual([
      "parent",
      "manager",
    ]);
    expect(parentColumns(columns, OTHER).map((column) => column.name)).toEqual([
      "client",
    ]);
  });

  it("nests by the link the view chose, or by the first", () => {
    const parents = parentColumns(columns, TABLE);
    expect(parentColumn({}, parents)).toBe("parent");
    expect(parentColumn({ parentColumn: "manager" }, parents)).toBe("manager");
    // A field that is no such link any more: the first again.
    expect(parentColumn({ parentColumn: "client" }, parents)).toBe("parent");
    expect(parentColumn({}, [])).toBeUndefined();
  });
});

describe("listLines", () => {
  const rows = [
    row("fruit"),
    row("apple", "fruit"),
    row("vegetable"),
    row("gala", "apple"),
    row("pear", "fruit"),
    row("leek", "vegetable"),
  ];

  it("draws each row under its parent, in the view's order among siblings", () => {
    expect(drawn(listLines(rows, "parent", new Set()))).toEqual([
      "fruit -",
      "  apple -",
      "    gala",
      "  pear",
      "vegetable -",
      "  leek",
    ]);
  });

  it("leaves out what is under a folded row, and keeps its count", () => {
    const lines = listLines(rows, "parent", new Set(["fruit", "leek"]));
    expect(drawn(lines)).toEqual(["fruit +", "vegetable -", "  leek"]);
    expect(lines[0]).toMatchObject({ children: 2, folded: true });
    // A row with nothing under it is not folded, whatever was kept of it.
    expect(lines[2]).toMatchObject({ children: 0, folded: false });
  });

  it("is a plain list without a link to nest by", () => {
    expect(drawn(listLines(rows, undefined, new Set()))).toEqual(
      rows.map((item) => item.id),
    );
  });

  it("hides no row whose parent was not read", () => {
    // The parent filtered out or past the ceiling: the row goes to the top.
    expect(
      drawn(
        listLines([row("gala", "apple"), row("leek")], "parent", new Set()),
      ),
    ).toEqual(["gala", "leek"]);
  });

  it("hides no row of a loop, and still nests what hangs from it", () => {
    const looping = [
      row("a", "b"),
      row("b", "a"),
      row("c", "a"),
      row("self", "self"),
      row("d", "c"),
    ];
    expect(drawn(listLines(looping, "parent", new Set()))).toEqual([
      "a -",
      "  c -",
      "    d",
      "b",
      "self",
    ]);
  });

  it("goes as deep as the rows do", () => {
    const chain = Array.from({ length: 4_000 }, (_, index) =>
      row(`r${String(index)}`, index > 0 ? `r${String(index - 1)}` : undefined),
    );
    const lines = listLines(chain, "parent", new Set());
    expect(lines).toHaveLength(4_000);
    expect(lines.at(-1)).toMatchObject({ level: 4_000, children: 0 });
  });
});
