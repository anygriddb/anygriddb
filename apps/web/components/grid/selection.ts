/**
 * The grid's selection, outside React state (ADR 0012): the active cell,
 * the anchor of a range, the cell being edited, and the end of a fill.
 * A cell reads only its own flags, so moving the selection re-renders the
 * cells whose look changes, never the whole grid.
 */
import { useSyncExternalStore } from "react";

export type Cell = { r: number; c: number };
export type Range = { r1: number; c1: number; r2: number; c2: number };

function normalize(a: Cell, b: Cell): Range {
  return {
    r1: Math.min(a.r, b.r),
    c1: Math.min(a.c, b.c),
    r2: Math.max(a.r, b.r),
    c2: Math.max(a.c, b.c),
  };
}

/**
 * The cell being edited: its row and field, which stay what they are when
 * rows are added or removed above it, and where they stand now.
 */
type Editing = { rowId: string; column: string; cell: Cell; text?: string };

type SelectionState = {
  active: Cell | null;
  anchor: Cell | null;
  editing: Editing | null;
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
  /** Reads what the open editor holds; it still answers once it is gone. */
  private draft: (() => string) | null = null;
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
    // What an editor held is its own: the next edit starts without it.
    if (
      next.editing?.rowId !== this.state.editing?.rowId ||
      next.editing?.column !== this.state.editing?.column
    ) {
      this.draft = null;
    }
    this.state = next;
    this.range = next.active
      ? normalize(next.anchor ?? next.active, next.active)
      : null;
    for (const listener of this.listeners) listener();
  }

  /**
   * Updates the selection only while it is still `held`, the state read
   * before a save began: what a fill or a paste selects once it is saved
   * must not replace what the person chose while it was being saved.
   */
  updateIfStill(held: SelectionState, patch: Partial<SelectionState>): void {
    if (this.state === held) this.update(patch);
  }

  /** The edit stays on its row: the selection goes where that row now is. */
  followEdit(cell: Cell): void {
    const { editing } = this.state;
    if (!editing || (editing.cell.r === cell.r && editing.cell.c === cell.c)) {
      return;
    }
    this.update({ editing: { ...editing, cell }, active: cell, anchor: null });
  }

  /** Notes how to read what the open editor holds. */
  holdDraft(read: () => string): void {
    this.draft = read;
  }

  /** What the last editor held, once. */
  takeDraft(): string {
    const text = this.draft?.() ?? "";
    this.draft = null;
    return text;
  }

  /**
   * The flags of the cell at row position `r`, column `c`, which holds
   * `column` of the row `rowId`: only those two say that it is edited.
   */
  flags(r: number, c: number, rowId?: string, column?: string): number {
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
    if (editing && editing.rowId === rowId && editing.column === column) {
      flags |= EDITING;
    }
    return flags;
  }

  /** True when any cell of this row is being edited. */
  isEditingRow(rowId: string | undefined): boolean {
    return rowId !== undefined && this.state.editing?.rowId === rowId;
  }
}

/** Re-renders when this cell's flags change, and only then. */
export function useCellFlags(
  selection: GridSelection,
  r: number,
  c: number,
  rowId: string | undefined,
  column: string,
): number {
  return useSyncExternalStore(selection.subscribe, () =>
    selection.flags(r, c, rowId, column),
  );
}

/** The whole selection, for parts that show it all, such as a menu. */
export function useSelectionState(selection: GridSelection): SelectionState {
  return useSyncExternalStore(selection.subscribe, selection.getState);
}

/**
 * Whether this row holds the cell being edited. Used to raise the row above
 * later virtualized rows so an overflowing panel keeps pointer events.
 */
export function useEditingRow(
  selection: GridSelection,
  rowId: string | undefined,
): boolean {
  return useSyncExternalStore(selection.subscribe, () =>
    selection.isEditingRow(rowId),
  );
}

/** The row being edited, if any: the grid keeps it drawn wherever it goes. */
export function useEditedRowId(selection: GridSelection): string | undefined {
  return useSyncExternalStore(
    selection.subscribe,
    () => selection.getState().editing?.rowId,
  );
}

/** The id of a cell's element, for `aria-activedescendant`. */
export function cellId(grid: string, r: number, c: number): string {
  return `${grid}-r${String(r)}-c${String(c)}`;
}
