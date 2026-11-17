import { useEffect } from "react";
import { tableTakesUndo, undoShortcut } from "../../lib/keyboard-undo";

/**
 * Ctrl Z and Ctrl Y (or Ctrl Shift Z) undo and redo the table's changes
 * wherever the focus is on its page, a cell's list panel included; text
 * being typed and dialogs keep their own.
 */
export function useUndoKeys(undo: () => void, redo: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = undoShortcut(event);
      // A list panel copies each key to its active option (untrusted).
      if (!action || !event.isTrusted || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!tableTakesUndo(target)) return;
      event.preventDefault();
      if (action === "undo") undo();
      else redo();
    };
    // Captured: a list panel stops the keys it gets from bubbling.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [undo, redo]);
}
