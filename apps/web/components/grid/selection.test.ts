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
    selection.update({
      editing: { rowId: "r3", column: "b", cell: { r: 3, c: 2 } },
    });
    expect(selection.flags(3, 2, "r3", "b") & EDITING).toBe(EDITING);
    expect(selection.isEditingRow("r3")).toBe(true);
    expect(selection.isEditingRow("r2")).toBe(false);
  });

  it("keeps the edit on its row when the rows shift under it", () => {
    const selection = new GridSelection();
    const cell = { r: 3, c: 2 };
    selection.update({
      active: cell,
      editing: { rowId: "r3", column: "b", cell },
    });
    // Another row came to that place: it is not the one edited.
    expect(selection.flags(3, 2, "r9", "b") & EDITING).toBe(0);
    // The edited row, wherever it now stands, still is.
    expect(selection.flags(2, 2, "r3", "b") & EDITING).toBe(EDITING);
    selection.followEdit({ r: 2, c: 2 });
    expect(selection.getState().active).toEqual({ r: 2, c: 2 });
    expect(selection.getState().editing?.cell).toEqual({ r: 2, c: 2 });
    expect(selection.getState().editing?.rowId).toBe("r3");
  });

  it("does not move anything when no edit is open, or it has not moved", () => {
    const selection = new GridSelection();
    selection.update({ active: { r: 1, c: 1 } });
    selection.followEdit({ r: 5, c: 5 });
    expect(selection.getState().active).toEqual({ r: 1, c: 1 });
    const cell = { r: 2, c: 0 };
    selection.update({
      active: cell,
      editing: { rowId: "r2", column: "a", cell },
    });
    const listener = vi.fn();
    selection.subscribe(listener);
    selection.followEdit({ r: 2, c: 0 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("gives back what an editor held, once, even after it is gone", () => {
    const selection = new GridSelection();
    expect(selection.takeDraft()).toBe("");
    selection.holdDraft(() => "typed");
    expect(selection.takeDraft()).toBe("typed");
    expect(selection.takeDraft()).toBe("");
  });

  it("does not hand one editor's text to the next", () => {
    const selection = new GridSelection();
    const cell = { r: 0, c: 0 };
    selection.update({ editing: { rowId: "r1", column: "a", cell } });
    selection.holdDraft(() => "for r1");
    // Moved with its row, it is the same edit.
    selection.followEdit({ r: 1, c: 0 });
    selection.update({ editing: { rowId: "r2", column: "a", cell } });
    expect(selection.takeDraft()).toBe("");
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

  it("leaves alone what was chosen while a save lasted", () => {
    const selection = new GridSelection();
    selection.update({ active: { r: 0, c: 0 } });
    // Nothing moved since the save began: what it selects is taken.
    const untouched = selection.getState();
    selection.updateIfStill(untouched, {
      anchor: { r: 0, c: 0 },
      active: { r: 2, c: 0 },
    });
    expect(selection.getRange()).toEqual({ r1: 0, c1: 0, r2: 2, c2: 0 });
    // Another cell was chosen meanwhile: it stays.
    const before = selection.getState();
    selection.update({ anchor: null, active: { r: 5, c: 1 } });
    selection.updateIfStill(before, { active: { r: 9, c: 9 } });
    expect(selection.getState().active).toEqual({ r: 5, c: 1 });
  });
});
