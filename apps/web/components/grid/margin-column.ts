/**
 * The column whose right rule is drawn as the ledger's red margin: where
 * what stays put ends and what scrolls begins. The last frozen column, or
 * the row gutter (-1) when no column is frozen.
 */
export function marginColumn(frozenCount: number): number {
  return frozenCount > 0 ? frozenCount - 1 : -1;
}

/** Width of the row gutter: the number, the checkbox, the expand button. */
export const GUTTER = 56;
