import { useState } from "react";
import { UndoStack, type UndoSizes } from "../../lib/undo-stack";
/** Client-side undo stack for this table session (`UndoStack`). */
export function useUndo() {
  // What rendering needs from the stack, kept in state so a change shows.
  const [sizes, setSizes] = useState<UndoSizes>({ past: 0, future: 0 });
  const [stack] = useState(() => new UndoStack(setSizes));
  return {
    push: stack.push,
    undo: stack.undo,
    redo: stack.redo,
    canUndo: sizes.past > 0,
    canRedo: sizes.future > 0,
  };
}
