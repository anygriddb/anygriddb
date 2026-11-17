import { describe, expect, it } from "vitest";
import { sheetGeometry } from "./grid-geometry";
import { ADD_FIELD_WIDTH, GUTTER } from "./margin-column";

describe("sheetGeometry", () => {
  it("places each column after the gutter and the columns before it", () => {
    const geometry = sheetGeometry([100, 200, 50], 1, ADD_FIELD_WIDTH);
    expect(geometry.offsets).toEqual([GUTTER, GUTTER + 100, GUTTER + 300]);
    expect(geometry.sheetWidth).toBe(GUTTER + 350 + ADD_FIELD_WIDTH);
    expect(geometry.totalWidth).toBe(GUTTER + 350 + 120);
    expect(geometry.frozenCount).toBe(1);
    expect(geometry.frozenWidth).toBe(100);
  });

  it("freezes no more columns than there are, and none on an empty sheet", () => {
    const all = sheetGeometry([100, 200], 5, 0);
    expect(all.frozenCount).toBe(2);
    expect(all.frozenWidth).toBe(300);
    const none = sheetGeometry([], 1, 0);
    expect(none.offsets).toEqual([]);
    expect(none.frozenCount).toBe(0);
    expect(none.frozenWidth).toBe(0);
    expect(none.sheetWidth).toBe(GUTTER);
  });
});
