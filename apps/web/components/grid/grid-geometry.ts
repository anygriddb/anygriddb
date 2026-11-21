import { GUTTER } from "./margin-column";

/** Room past the last field, so that it scrolls clear of the edge. */
const END_ROOM = 120;

/**
 * What the columns that scroll keep of the window, whatever the view
 * freezes: more than a column of the default width. Frozen columns wider
 * than the window would cover every other one, and the column that adds
 * a field, with no way to scroll them into view.
 */
export const SCROLL_ROOM = 240;

/**
 * Where a grid's columns stand, from their widths. The sheet starts after
 * the row gutter and ends after its last field and the column that adds
 * one (`trailing` wide, when there is one); the first `frozen` columns
 * stay in view as the others scroll, as many of them as leave the others
 * `SCROLL_ROOM` of the `shown` width, once it is known.
 */
export function sheetGeometry(
  widths: readonly number[],
  frozen: number,
  trailing: number,
  shown?: number,
): {
  /** The left edge of each column. */
  offsets: number[];
  /** Up to the end of the last field and of the column that adds one. */
  sheetWidth: number;
  /** What the grid scrolls over. */
  totalWidth: number;
  /** How many columns stay in view: no more than there are, or fit. */
  frozenCount: number;
  /** The width the frozen columns take, the gutter aside. */
  frozenWidth: number;
} {
  const offsets: number[] = [];
  let end = GUTTER;
  for (const width of widths) {
    offsets.push(end);
    end += width;
  }
  let frozenCount = Math.min(frozen, widths.length);
  if (shown !== undefined) {
    while (
      frozenCount > 0 &&
      (offsets[frozenCount] ?? end) > shown - SCROLL_ROOM
    ) {
      frozenCount -= 1;
    }
  }
  return {
    offsets,
    sheetWidth: end + trailing,
    totalWidth: end + END_ROOM,
    frozenCount,
    frozenWidth: (offsets[frozenCount] ?? end) - GUTTER,
  };
}
