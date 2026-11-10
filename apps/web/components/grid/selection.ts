/**
 * The grid's selection, outside React state (ADR 0012): the active cell,
 * the anchor of a range, the cell being edited, and the end of a fill.
 * A cell reads only its own flags, so moving the selection re-renders the
 * cells whose look changes, never the whole grid.
 */
import { useSyncExternalStore } from "react";

export type Cell = { r: number; c: number };
export type Range = { r1: number; c1: number; r2: number; c2: number };

export function normalize(a: Cell, b: Cell): Range {
  return {
    r1: Math.min(a.r, b.r),
    c1: Math.min(a.c, b.c),
    r2: Math.max(a.r, b.r),
    c2: Math.max(a.c, b.c),
  };
}

export type SelectionState = {
  active: Cell | null;
  anchor: Cell | null;
  editing: { cell: Cell; text?: string } | null;
  /** The last row a fill drag reaches, while it lasts. */
  fillTo: number | null;
};

/** What a cell draws. */
export const SELECTED = 1;
export const ACTIVE = 2;
/** Inside the rows a fill drag would write. */
export const FILLING = 4;
/** The bottom-right cell of the range, which holds the fill handle. */
export const CORNER = 8;
export const EDITING = 16;

const EMPTY: SelectionState = {
  active: null,
  anchor: null,
  editing: null,
  fillTo: null,
};

export class GridSelection {
  private state = EMPTY;
  private range: Range | null = null;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = () => this.state;

  /** The selected range, from the anchor (or the active cell) to the active cell. */
  getRange(): Range | null {
    return this.range;
  }

  update(patch: Partial<SelectionState>): void {
    const next = { ...this.state, ...patch };
    if (
      next.active === this.state.active &&
      next.anchor === this.state.anchor &&
      next.editing === this.state.editing &&
      next.fillTo === this.state.fillTo
    ) {
      return;
    }
    this.state = next;
    this.range = next.active
      ? normalize(next.anchor ?? next.active, next.active)
      : null;
    for (const listener of this.listeners) listener();
  }

  /** The flags of the cell at row position `r`, column `c`. */
  flags(r: number, c: number): number {
    const { active, editing, fillTo } = this.state;
    const range = this.range;
    let flags = 0;
    if (range) {
      const inColumns = c >= range.c1 && c <= range.c2;
      if (inColumns && r >= range.r1 && r <= range.r2) flags |= SELECTED;
      if (inColumns && fillTo !== null && r > range.r2 && r <= fillTo)
        flags |= FILLING;
      if (r === range.r2 && c === range.c2) flags |= CORNER;
    }
    if (active?.r === r && active.c === c) flags |= ACTIVE;
    if (editing?.cell.r === r && editing.cell.c === c) flags |= EDITING;
    return flags;
  }

  /** True when any cell of this row is being edited. */
  isEditingRow(r: number): boolean {
    return this.state.editing?.cell.r === r;
  }
}

/** Re-renders when this cell's flags change, and only then. */
export function useCellFlags(
  selection: GridSelection,
  r: number,
  c: number,
): number {
  return useSyncExternalStore(selection.subscribe, () => selection.flags(r, c));
}

/** The whole selection, for parts that show it all, such as a menu. */
export function useSelectionState(selection: GridSelection): SelectionState {
  return useSyncExternalStore(selection.subscribe, selection.getState);
}

/**
 * Whether this row holds the cell being edited. Used to raise the row above
 * later virtualized rows so an overflowing panel keeps pointer events.
 */
export function useEditingRow(selection: GridSelection, r: number): boolean {
  return useSyncExternalStore(selection.subscribe, () =>
    selection.isEditingRow(r),
  );
}

/** The id of a cell's element, for `aria-activedescendant`. */
export function cellId(grid: string, r: number, c: number): string {
  return `${grid}-r${String(r)}-c${String(c)}`;
}
