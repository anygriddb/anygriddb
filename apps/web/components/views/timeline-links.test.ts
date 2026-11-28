import { describe, expect, it } from "vitest";
import type { CatalogColumn, RowItem } from "../../lib/types";
import {
  arrowHead,
  arrowPath,
  arrowsBetween,
  barSpan,
  dependencyColumn,
  dependencyColumns,
  predecessorsOf,
  startsEarly,
} from "./timeline-links";

const DAY = 86_400_000;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

function link(
  name: string,
  relation: CatalogColumn["relation"],
  fieldType: string,
): CatalogColumn {
  return { name, fieldType, relation } as unknown as CatalogColumn;
}

describe("the links a timeline draws dependencies by", () => {
  const columns = [
    link(
      "after",
      { kind: "many_to_many", targetTableId: "t1" } as never,
      "relation_many_to_many",
    ),
    link(
      "parent",
      {
        kind: "one_to_many",
        targetTableId: "t1",
        direction: "forward",
      } as never,
      "relation_one_to_many",
    ),
    link(
      "children",
      {
        kind: "one_to_many",
        targetTableId: "t1",
        direction: "inverse",
      } as never,
      "relation_one_to_many",
    ),
    link(
      "client",
      {
        kind: "one_to_many",
        targetTableId: "t2",
        direction: "forward",
      } as never,
      "relation_one_to_many",
    ),
    { name: "due", fieldType: "date" } as unknown as CatalogColumn,
  ];

  it("takes a link of the table to itself, read from its forward side", () => {
    expect(
      dependencyColumns(columns, "t1").map((column) => column.name),
    ).toEqual(["after", "parent"]);
  });

  it("draws by the one the view chose, and by none until it chose one", () => {
    const candidates = dependencyColumns(columns, "t1");
    expect(dependencyColumn({ dependencyColumn: "after" }, candidates)).toBe(
      "after",
    );
    expect(dependencyColumn({}, candidates)).toBeUndefined();
    expect(
      dependencyColumn({ dependencyColumn: "client" }, candidates),
    ).toBeUndefined();
  });

  it("reads the rows a row comes after from its link", () => {
    const row = {
      id: "r2",
      after: [{ id: "r1", label: "Design" }],
    } as unknown as RowItem;
    expect(predecessorsOf(row, "after")).toEqual([
      { id: "r1", label: "Design" },
    ]);
    expect(predecessorsOf(row, undefined)).toEqual([]);
    expect(predecessorsOf({ id: "r3" } as RowItem, "after")).toEqual([]);
  });
});

describe("bars, and the arrows between them", () => {
  const span = (from: string, to?: string) =>
    barSpan(
      { id: "x", start: from, end: to ?? null } as unknown as RowItem,
      "start",
      "end",
    );

  it("spans a bar from its first day to the day after its last", () => {
    expect(span("2026-03-02", "2026-03-04")).toEqual({
      from: day("2026-03-02"),
      until: day("2026-03-05"),
    });
    // No end: one day. An end before the start: the start's day.
    expect(span("2026-03-02")).toEqual({
      from: day("2026-03-02"),
      until: day("2026-03-03"),
    });
    expect(span("2026-03-02", "2026-02-01")?.until).toBe(day("2026-03-03"));
    expect(barSpan({ id: "x" } as RowItem, "start", "end")).toBeNull();
  });

  it("says a row starts early when it starts before the row it comes after ends", () => {
    const design = { from: day("2026-03-02"), until: day("2026-03-05") };
    expect(startsEarly({ from: day("2026-03-05"), until: 0 }, design)).toBe(
      false,
    );
    expect(startsEarly({ from: day("2026-03-04"), until: 0 }, design)).toBe(
      true,
    );
  });

  it("draws an arrow between two lines on screen, held to the period", () => {
    const min = day("2026-03-01");
    const arrows = arrowsBetween({
      min,
      max: min + 31 * DAY,
      perDay: 10,
      lines: [
        {
          rowId: "design",
          middle: 50,
          span: { from: day("2026-03-02"), until: day("2026-03-05") },
          after: [],
        },
        {
          rowId: "build",
          middle: 86,
          span: { from: day("2026-03-04"), until: day("2026-03-10") },
          after: ["design", "gone", "build"],
        },
      ],
    });
    // Only the line on screen draws: not one gone, nor the row itself.
    expect(arrows).toEqual([
      {
        key: "design>build",
        from: { x: 40, y: 50 },
        to: { x: 30, y: 86 },
        early: true,
      },
    ]);
    // Late, the arrow goes around between the two lines.
    expect(arrowPath(arrows[0] ?? never())).toBe(
      "M 40 50 H 46 V 68 H 24 V 86 H 30",
    );
    expect(
      arrowPath({
        key: "a>b",
        from: { x: 40, y: 50 },
        to: { x: 80, y: 86 },
        early: false,
      }),
    ).toBe("M 40 50 H 46 V 86 H 80");
    // Its head points into the later bar.
    expect(
      arrowHead({
        key: "a>b",
        from: { x: 40, y: 50 },
        to: { x: 80, y: 86 },
        early: false,
      }),
    ).toBe("M 80 86 L 75 82.5 L 75 89.5 Z");
  });
});

function never(): never {
  throw new Error("no arrow");
}
