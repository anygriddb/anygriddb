import { MAX_FROZEN_COLUMNS } from "@anygriddb/core";

/**
 * The column whose right rule is drawn as the ledger's red margin: where
 * what stays put ends and what scrolls begins. The last frozen column, or
 * the row gutter (-1) when no column is frozen.
 */
export function marginColumn(frozenCount: number): number {
  return frozenCount > 0 ? frozenCount - 1 : -1;
}

/**
 * Next freeze depth after choosing a column header: freeze through that
 * column (capped at MAX_FROZEN_COLUMNS), or clear all freezes when that
 * column is already the freeze margin.
 */
export function nextFrozenColumns(
  current: number,
  columnIndex: number,
): number {
  const target = Math.min(MAX_FROZEN_COLUMNS, columnIndex + 1);
  return target === current ? 0 : target;
}

/** Width of the row gutter: the number, the checkbox, the expand button. */
export const GUTTER = 56;
