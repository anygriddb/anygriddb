import { describe, expect, it } from "vitest";
import {
  LIST_PANEL_ATTRIBUTE,
  tableTakesUndo,
  undoShortcut,
  type UndoTarget,
} from "./keyboard-undo";

const keys = (
  key: string,
  extra: Partial<Parameters<typeof undoShortcut>[0]> = {},
) => ({
  key,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...extra,
});

/** An element inside the given ancestors, matched by attribute or role. */
const element = (
  tagName: string,
  within: string[] = [],
  extra: Partial<UndoTarget> = {},
): UndoTarget => ({
  tagName,
  closest: (selector) =>
    within.some((mark) => selector.includes(mark)) ? {} : null,
  ...extra,
});

describe("undoShortcut", () => {
  it("reads Ctrl or ⌘ Z as undo, with Shift or Y as redo", () => {
    expect(undoShortcut(keys("z"))).toBe("undo");
    expect(undoShortcut(keys("Z", { shiftKey: true }))).toBe("redo");
    expect(undoShortcut(keys("y"))).toBe("redo");
    expect(undoShortcut(keys("z", { ctrlKey: false, metaKey: true }))).toBe(
      "undo",
    );
  });

  it("ignores other keys, Alt, a bare Z, and text being composed", () => {
    expect(undoShortcut(keys("c"))).toBeNull();
    expect(undoShortcut(keys("z", { altKey: true }))).toBeNull();
    expect(undoShortcut(keys("z", { ctrlKey: false }))).toBeNull();
    expect(undoShortcut(keys("z", { isComposing: true }))).toBeNull();
  });
});

describe("tableTakesUndo", () => {
  it("takes presses outside text: the grid, a button, a list panel's empty search", () => {
    expect(tableTakesUndo(null)).toBe(true);
    expect(tableTakesUndo(element("div"))).toBe(true);
    expect(tableTakesUndo(element("button"))).toBe(true);
    expect(
      tableTakesUndo(element("input", [], { type: "checkbox", value: "on" })),
    ).toBe(true);
    expect(
      tableTakesUndo(
        element("input", [LIST_PANEL_ATTRIBUTE], { type: "text", value: "" }),
      ),
    ).toBe(true);
  });

  it("leaves text being typed and dialogs their own undo", () => {
    expect(tableTakesUndo(element("textarea"))).toBe(false);
    expect(
      tableTakesUndo(element("div", [], { isContentEditable: true })),
    ).toBe(false);
    expect(
      tableTakesUndo(element("input", [], { type: "text", value: "" })),
    ).toBe(false);
    expect(
      tableTakesUndo(
        element("input", [LIST_PANEL_ATTRIBUTE], {
          type: "text",
          value: "wo",
        }),
      ),
    ).toBe(false);
    expect(tableTakesUndo(element("button", ["dialog"]))).toBe(false);
  });
});
