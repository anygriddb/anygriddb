/**
 * Moving a row by drag and drop, onto a kanban column or a calendar day.
 * React Aria's hooks (ADR 0012) drive it by mouse, touch, keyboard, and
 * screen reader alike; the row travels as its id under a type of its own.
 */
import { isTextDropItem, useDrag, useDrop } from "@anygriddb/ui";
import type { RefObject } from "react";

const ROW_TYPE = "application/x-anygriddb-row";

export function useRowDrag(rowId: string, label: string, enabled: boolean) {
  return useDrag({
    isDisabled: !enabled,
    getItems: () => [{ [ROW_TYPE]: rowId, "text/plain": label }],
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
