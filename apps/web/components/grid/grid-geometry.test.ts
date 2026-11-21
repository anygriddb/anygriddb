import { describe, expect, it } from "vitest";
import { SCROLL_ROOM, sheetGeometry } from "./grid-geometry";
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

  it("keeps in place only the frozen columns that leave the others room to scroll", () => {
    const widths = [200, 200, 200, 200, 200];
    // A window wide enough for the five and the room: all stay.
    const wide = sheetGeometry(widths, 5, 0, GUTTER + 1000 + SCROLL_ROOM);
    expect(wide.frozenCount).toBe(5);
    expect(wide.frozenWidth).toBe(1000);
    // One pixel less, and the last frozen column scrolls with the rest.
    const less = sheetGeometry(widths, 5, 0, GUTTER + 1000 + SCROLL_ROOM - 1);
    expect(less.frozenCount).toBe(4);
    expect(less.frozenWidth).toBe(800);
    // A window that has no room beside the first column keeps none.
    const narrow = sheetGeometry(widths, 5, 0, GUTTER + 200);
    expect(narrow.frozenCount).toBe(0);
    expect(narrow.frozenWidth).toBe(0);
    // Where the columns stand does not change: only which ones stay.
    expect(narrow.offsets).toEqual(wide.offsets);
    expect(narrow.totalWidth).toBe(wide.totalWidth);
  });

  it("keeps what the view freezes until the window is measured", () => {
    expect(sheetGeometry([200, 200, 200], 3, 0).frozenCount).toBe(3);
    expect(sheetGeometry([200, 200, 200], 3, 0, undefined).frozenCount).toBe(3);
  });
});
