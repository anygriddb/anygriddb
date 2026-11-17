import { GUTTER } from "./margin-column";

/** Room past the last field, so that it scrolls clear of the edge. */
const END_ROOM = 120;

/**
 * Where a grid's columns stand, from their widths. The sheet starts after
 * the row gutter and ends after its last field and the column that adds
 * one (`trailing` wide, when there is one); the first `frozen` columns
 * stay in view as the others scroll.
 */
export function sheetGeometry(
  widths: readonly number[],
  frozen: number,
  trailing: number,
): {
  /** The left edge of each column. */
  offsets: number[];
  /** Up to the end of the last field and of the column that adds one. */
  sheetWidth: number;
  /** What the grid scrolls over. */
  totalWidth: number;
  /** How many columns are frozen: no more than there are. */
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
  const frozenCount = Math.min(frozen, widths.length);
  return {
    offsets,
    sheetWidth: end + trailing,
    totalWidth: end + END_ROOM,
    frozenCount,
    frozenWidth: (offsets[frozenCount] ?? end) - GUTTER,
  };
}
