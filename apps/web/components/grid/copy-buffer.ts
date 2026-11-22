/**
 * What the last copy from a grid really held. The clipboard carries the
 * text a cell shows, for spreadsheets; a figure shown rounded would come
 * back rounded. The cells are kept here beside that text, and a paste
 * takes them only when the clipboard still holds it word for word.
 */

/** A cell as it was copied: the kind of its field, and its stored value. */
export type CopiedCell = { fieldType: string; value: unknown };

/** A clipboard may rewrite line endings and add a last one. */
function sameText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "");
}

export class CopyBuffer {
  private held: { text: string; cells: readonly CopiedCell[][] } | null = null;

  /** Remembers a copy, in place of the one before. */
  keep(text: string, cells: readonly CopiedCell[][]): void {
    this.held = { text: sameText(text), cells };
  }

  /** The cells of the copy that wrote `text`; null for any other text. */
  recall(text: string): readonly CopiedCell[][] | null {
    return this.held?.text === sameText(text) ? this.held.cells : null;
  }

  clear(): void {
    this.held = null;
  }
}

/** One per tab: a copy can be pasted into another table of the same tab. */
export const copyBuffer = new CopyBuffer();
