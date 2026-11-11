/** The keys of a press that undo needs. */
export type UndoKeys = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
};

/** What a press needs of the element it went to (`Element`). */
export type UndoTarget = {
  tagName: string;
  isContentEditable?: boolean;
  type?: string;
  value?: string;
  closest: (selector: string) => unknown;
};

/** Marks a cell's list panel, where an empty search has nothing to undo. */
export const LIST_PANEL_ATTRIBUTE = "data-list-panel";

const TEXT_INPUTS = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);

/** Ctrl (⌘) Z undoes; Ctrl Shift Z and Ctrl Y redo; anything else is not undo. */
export function undoShortcut(keys: UndoKeys): "undo" | "redo" | null {
  if (keys.isComposing || keys.altKey || !(keys.ctrlKey || keys.metaKey)) {
    return null;
  }
  const key = keys.key.toLowerCase();
  if (key === "z") return keys.shiftKey ? "redo" : "undo";
  if (key === "y" && !keys.shiftKey) return "redo";
  return null;
}

/**
 * Whether the table's undo takes a press that went to `target`. Text
 * being typed keeps its own undo: a text field, a text area, an editor.
 * The empty search of a cell's list panel has nothing of its own to
 * undo, so the last choice made in the panel is undone. A dialog keeps
 * its keys.
 */
export function tableTakesUndo(target: UndoTarget | null): boolean {
  if (!target) return true;
  if (target.closest('[role="dialog"], [role="alertdialog"]')) return false;
  if (target.isContentEditable) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "textarea") return false;
  if (tag !== "input") return true;
  if (!TEXT_INPUTS.has((target.type ?? "text").toLowerCase())) return true;
  return (
    (target.value ?? "") === "" &&
    Boolean(target.closest(`[${LIST_PANEL_ATTRIBUTE}]`))
  );
}
