import { describe, expect, it } from "vitest";
import { gridKeyAction, togglesCheckbox, type KeyPress } from "./grid-keys";

function press(key: string, held: Partial<KeyPress> = {}): KeyPress {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...held,
  };
}

const sheet = { active: { r: 2, c: 1 }, rows: 10, columns: 4 };

describe("gridKeyAction", () => {
  it("opens the field's menu with Alt Down, and moves down without Alt", () => {
    expect(gridKeyAction(press("ArrowDown", { altKey: true }), sheet)).toEqual({
      kind: "fieldMenu",
    });
    expect(gridKeyAction(press("ArrowUp", { altKey: true }), sheet)).toEqual({
      kind: "move",
      cell: { r: 1, c: 1 },
      extend: false,
    });
  });

  it("moves the active cell with the arrows, and to an end with Ctrl or Cmd", () => {
    expect(gridKeyAction(press("ArrowDown"), sheet)).toEqual({
      kind: "move",
      cell: { r: 3, c: 1 },
      extend: false,
    });
    expect(gridKeyAction(press("ArrowUp", { shiftKey: true }), sheet)).toEqual({
      kind: "move",
      cell: { r: 1, c: 1 },
      extend: true,
    });
    expect(gridKeyAction(press("ArrowDown", { ctrlKey: true }), sheet)).toEqual(
      { kind: "move", cell: { r: 9, c: 1 }, extend: false },
    );
    expect(gridKeyAction(press("ArrowLeft", { metaKey: true }), sheet)).toEqual(
      { kind: "move", cell: { r: 2, c: 0 }, extend: false },
    );
    expect(
      gridKeyAction(press("ArrowRight", { ctrlKey: true }), sheet),
    ).toEqual({ kind: "move", cell: { r: 2, c: 3 }, extend: false });
  });

  it("goes to a row's ends, the sheet's corners, and a page up or down", () => {
    expect(gridKeyAction(press("Home"), sheet)).toMatchObject({
      cell: { r: 2, c: 0 },
    });
    expect(gridKeyAction(press("End"), sheet)).toMatchObject({
      cell: { r: 2, c: 3 },
    });
    expect(
      gridKeyAction(press("Home", { ctrlKey: true }), sheet),
    ).toMatchObject({ cell: { r: 0, c: 0 } });
    expect(gridKeyAction(press("End", { ctrlKey: true }), sheet)).toMatchObject(
      {
        cell: { r: 9, c: 3 },
      },
    );
    // The grid keeps the cell within the sheet: this only says how far.
    expect(gridKeyAction(press("PageDown"), sheet)).toMatchObject({
      cell: { r: 17, c: 1 },
    });
    expect(gridKeyAction(press("PageUp"), sheet)).toMatchObject({
      cell: { r: -13, c: 1 },
    });
  });

  it("walks a row with Tab, and leaves the grid past its ends", () => {
    expect(gridKeyAction(press("Tab"), sheet)).toEqual({
      kind: "move",
      cell: { r: 2, c: 2 },
      extend: false,
    });
    expect(
      gridKeyAction(press("Tab"), { ...sheet, active: { r: 2, c: 3 } }),
    ).toEqual({ kind: "leave", backward: false });
    expect(
      gridKeyAction(press("Tab", { shiftKey: true }), {
        ...sheet,
        active: { r: 2, c: 0 },
      }),
    ).toEqual({ kind: "leave", backward: true });
  });

  it("edits, opens the row, empties, fills down, and selects all", () => {
    expect(gridKeyAction(press("Enter"), sheet)).toEqual({ kind: "edit" });
    expect(gridKeyAction(press("F2"), sheet)).toEqual({ kind: "edit" });
    expect(gridKeyAction(press("Enter", { shiftKey: true }), sheet)).toEqual({
      kind: "open",
    });
    expect(gridKeyAction(press(" "), sheet)).toEqual({ kind: "open" });
    expect(gridKeyAction(press("Escape"), sheet)).toEqual({ kind: "deselect" });
    expect(gridKeyAction(press("Delete"), sheet)).toEqual({ kind: "clear" });
    expect(gridKeyAction(press("Backspace"), sheet)).toEqual({ kind: "clear" });
    expect(gridKeyAction(press("d", { ctrlKey: true }), sheet)).toEqual({
      kind: "fillDown",
    });
    expect(gridKeyAction(press("A", { metaKey: true }), sheet)).toEqual({
      kind: "selectAll",
    });
  });

  it("starts typing with a character, the one pressed", () => {
    expect(gridKeyAction(press("x"), sheet)).toEqual({
      kind: "edit",
      text: "x",
    });
    expect(gridKeyAction(press("É", { shiftKey: true }), sheet)).toEqual({
      kind: "edit",
      text: "É",
    });
  });

  it("asks nothing for a shortcut that is not its own", () => {
    expect(gridKeyAction(press("c", { ctrlKey: true }), sheet)).toBeNull();
    expect(gridKeyAction(press("x", { altKey: true }), sheet)).toBeNull();
    expect(gridKeyAction(press(" ", { ctrlKey: true }), sheet)).toBeNull();
    expect(gridKeyAction(press("Shift"), sheet)).toBeNull();
    expect(gridKeyAction(press("F5"), sheet)).toBeNull();
  });

  it("enters the sheet at its first cell on an arrow, when no cell is active", () => {
    const idle = { active: null, rows: 3, columns: 2 };
    expect(gridKeyAction(press("ArrowDown"), idle)).toEqual({
      kind: "move",
      cell: { r: 0, c: 0 },
      extend: false,
    });
    expect(gridKeyAction(press("Enter"), idle)).toBeNull();
    expect(gridKeyAction(press("x"), idle)).toBeNull();
    expect(gridKeyAction(press("ArrowDown"), { ...idle, rows: 0 })).toBeNull();
  });
});

describe("togglesCheckbox", () => {
  it("takes Enter, F2 and a double click, which carry no character", () => {
    expect(togglesCheckbox(undefined)).toBe(true);
  });

  it("ignores a character typed on the cell", () => {
    for (const key of ["n", "y", "x", "0", "É"]) {
      expect(togglesCheckbox(key)).toBe(false);
    }
  });
});
