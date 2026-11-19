/**
 * Moving a row by drag and drop: onto a kanban column or a calendar day,
 * or beside another row of a grid or a kanban stack. React Aria's hooks
 * (ADR 0012) drive it by mouse, touch, keyboard, and screen reader alike;
 * the row travels as its id under a type of its own.
 */
import { isTextDropItem, useDrag, useDrop } from "@anygriddb/ui";
import type { RefObject } from "react";
import { dropPlace, type RowPlace } from "./row-place";

const ROW_TYPE = "application/x-anygriddb-row";

/** Where a row sits in a list of rows: a grid, or one kanban stack. */
export type ListSlot = { list: string; index: number };

/**
 * The row being dragged in this tab, and where it was, while it is. Held
 * in an object that is never replaced: the React Compiler takes a
 * module's variable for a constant and reads it where it is used, so a
 * drop that noted where the row came from would read it again once the
 * drag had ended, and find nothing (a card dropped from the keyboard on
 * the one below it stayed where it was).
 */
const drag: { row: (ListSlot & { rowId: string }) | null } = { row: null };

/**
 * A row carried by the pointer from the element that takes `dragProps`.
 * From the keyboard and a screen reader it is picked up by a handle of
 * its own (`dragButtonProps`, on a `DragHandle`), never by the element:
 * what a card holds, such as the button that opens its row, keeps its
 * keys and its clicks.
 */
export function useRowDrag(
  rowId: string,
  label: string,
  enabled: boolean,
  from?: ListSlot,
) {
  return useDrag({
    isDisabled: !enabled,
    hasDragButton: true,
    getItems: () => [{ [ROW_TYPE]: rowId, "text/plain": label }],
    onDragStart: () => {
      drag.row = from ? { rowId, ...from } : null;
    },
    onDragEnd: () => {
      drag.row = null;
    },
  });
}

/** Calls `onRow` with the id of each row dropped on `ref`. */
export function useRowDrop(
  ref: RefObject<HTMLElement | null>,
  onRow: (rowId: string) => void,
) {
  return useDrop({
    ref,
    getDropOperation: (types) => (types.has(ROW_TYPE) ? "move" : "cancel"),
    onDrop: (event) => {
      for (const item of event.items) {
        if (isTextDropItem(item) && item.types.has(ROW_TYPE)) {
          // The text of a drag item is read asynchronously.
          void item.getText(ROW_TYPE).then(onRow);
        }
      }
    },
  });
}

/**
 * A row as a place to drop another: the row dropped takes its slot
 * (`dropPlace`). `side` says where it would land while one hovers it.
 */
export function useRowPlaceDrop(
  ref: RefObject<HTMLElement | null>,
  target: ListSlot & { rowId: string },
  /** The row dropped, where it goes, and where it was when it came from this list. */
  onPlace: (rowId: string, place: RowPlace, from: number | undefined) => void,
  enabled: boolean,
) {
  const origin = (rowId: string) =>
    drag.row?.rowId === rowId && drag.row.list === target.list
      ? drag.row.index
      : undefined;
  const drop = useDrop({
    ref,
    isDisabled: !enabled,
    getDropOperation: (types) => (types.has(ROW_TYPE) ? "move" : "cancel"),
    onDrop: (event) => {
      // Where the row came from is read now: the drag ends before its id
      // is read.
      const from = drag.row;
      for (const item of event.items) {
        if (!isTextDropItem(item) || !item.types.has(ROW_TYPE)) continue;
        void item.getText(ROW_TYPE).then((rowId) => {
          if (rowId === target.rowId) return;
          const index =
            from?.rowId === rowId && from.list === target.list
              ? from.index
              : undefined;
          onPlace(rowId, dropPlace(index, target.index, target.rowId), index);
        });
      }
    },
  });
  const side: "before" | "after" | null = drop.isDropTarget
    ? "after" in
      dropPlace(
        drag.row ? origin(drag.row.rowId) : undefined,
        target.index,
        target.rowId,
      )
      ? "after"
      : "before"
    : null;
  return { ...drop, side };
}
