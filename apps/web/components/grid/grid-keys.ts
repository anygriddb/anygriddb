import type { Cell } from "./selection";

/** What a key press holds, as a keyboard event gives it. */
export type KeyPress = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** What a key asks of the grid. */
export type GridKeyAction =
  /** The active cell goes there (kept within the sheet); Shift extends the range. */
  | { kind: "move"; cell: Cell; extend: boolean }
  /** Tab past a row's end: the focus leaves the grid, forward or backward. */
  | { kind: "leave"; backward: boolean }
  /** The active cell is edited; a typed character starts its new text. */
  | { kind: "edit"; text?: string }
  /** The active row opens in its panel. */
  | { kind: "open" }
  /** The range is given up; the active cell stays. */
  | { kind: "deselect" }
  /** The range's cells are emptied. */
  | { kind: "clear" }
  /** The range's first row is copied down it. */
  | { kind: "fillDown" }
  /** Every cell is selected. */
  | { kind: "selectAll" };

/** How far Page Up and Page Down go. */
const PAGE = 15;

/**
 * What a key pressed on the grid asks of it, when no cell is being
 * edited: the arrows, Home, End, and the page keys move the active cell
 * (with Ctrl or Cmd, to an end of the sheet); Tab walks a row and leaves
 * the grid past its ends; Enter and F2 edit, Shift Enter and Space open
 * the row; Delete empties the range; Ctrl D fills it down, Ctrl A takes
 * every cell; a character starts typing. Nothing for any other key.
 */
export function gridKeyAction(
  press: KeyPress,
  state: {
    /** The active cell, if any: with it, a range is selected. */
    active: Cell | null;
    /** How many rows and fields the sheet shows. */
    rows: number;
    columns: number;
  },
): GridKeyAction | null {
  const { active } = state;
  const mod = press.ctrlKey || press.metaKey;
  const extend = press.shiftKey;
  if (!active) {
    // The first arrow enters the sheet at its first cell.
    return press.key.startsWith("Arrow") && state.rows > 0
      ? { kind: "move", cell: { r: 0, c: 0 }, extend: false }
      : null;
  }
  const lastRow = state.rows - 1;
  const lastColumn = state.columns - 1;
  switch (press.key) {
    case "ArrowUp":
      return {
        kind: "move",
        cell: { r: mod ? 0 : active.r - 1, c: active.c },
        extend,
      };
    case "ArrowDown":
      return {
        kind: "move",
        cell: { r: mod ? lastRow : active.r + 1, c: active.c },
        extend,
      };
    case "ArrowLeft":
      return {
        kind: "move",
        cell: { r: active.r, c: mod ? 0 : active.c - 1 },
        extend,
      };
    case "ArrowRight":
      return {
        kind: "move",
        cell: { r: active.r, c: mod ? lastColumn : active.c + 1 },
        extend,
      };
    case "Tab": {
      // Past the row's last field, or before its first, Tab leaves the
      // grid for the page's next control, as from any other: the
      // keyboard is never held in it.
      const next = active.c + (extend ? -1 : 1);
      return next < 0 || next > lastColumn
        ? { kind: "leave", backward: extend }
        : { kind: "move", cell: { r: active.r, c: next }, extend: false };
    }
    case "Home":
      return {
        kind: "move",
        cell: { r: mod ? 0 : active.r, c: 0 },
        extend,
      };
    case "End":
      return {
        kind: "move",
        cell: { r: mod ? lastRow : active.r, c: lastColumn },
        extend,
      };
    case "PageDown":
      return {
        kind: "move",
        cell: { r: active.r + PAGE, c: active.c },
        extend,
      };
    case "PageUp":
      return {
        kind: "move",
        cell: { r: active.r - PAGE, c: active.c },
        extend,
      };
    case "Enter":
    case "F2":
      return extend ? { kind: "open" } : { kind: "edit" };
    case " ":
      return mod ? null : { kind: "open" };
    case "Escape":
      return { kind: "deselect" };
    case "Delete":
    case "Backspace":
      return { kind: "clear" };
  }
  if (mod && press.key.toLowerCase() === "d") return { kind: "fillDown" };
  if (mod && press.key.toLowerCase() === "a") return { kind: "selectAll" };
  if (!mod && !press.altKey && press.key.length === 1) {
    return { kind: "edit", text: press.key };
  }
  return null;
}

/**
 * Whether a request to edit a checkbox toggles it: Enter, F2, and a double
 * click do. A character typed on it is not a request to change it.
 */
export function togglesCheckbox(typed: string | undefined): boolean {
  return typed === undefined;
}
