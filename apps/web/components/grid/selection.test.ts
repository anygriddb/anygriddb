import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE,
  CORNER,
  EDITING,
  FILLING,
  GridSelection,
  SELECTED,
} from "./selection";

describe("grid selection", () => {
  it("flags the range, the active cell, and the fill handle's corner", () => {
    const selection = new GridSelection();
    selection.update({ anchor: { r: 1, c: 1 }, active: { r: 3, c: 2 } });
    expect(selection.getRange()).toEqual({ r1: 1, c1: 1, r2: 3, c2: 2 });
    expect(selection.flags(0, 0)).toBe(0);
    expect(selection.flags(2, 1)).toBe(SELECTED);
    expect(selection.flags(3, 2)).toBe(SELECTED | ACTIVE | CORNER);
    selection.update({ fillTo: 5 });
    expect(selection.flags(4, 1)).toBe(FILLING);
    expect(selection.flags(4, 3)).toBe(0);
    selection.update({ editing: { cell: { r: 3, c: 2 } } });
    expect(selection.flags(3, 2) & EDITING).toBe(EDITING);
    expect(selection.isEditingRow(3)).toBe(true);
    expect(selection.isEditingRow(2)).toBe(false);
  });

  it("tells subscribers only about real changes", () => {
    const selection = new GridSelection();
    const listener = vi.fn();
    selection.subscribe(listener);
    const cell = { r: 0, c: 0 };
    selection.update({ active: cell });
    selection.update({ active: cell });
    expect(listener).toHaveBeenCalledOnce();
    // The range runs from the active cell alone without an anchor.
    expect(selection.getRange()).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
  });
});
