/**
 * Columns in the view's field order, then any column the order omits. The
 * primary field comes first whatever the order: it names the row, so it
 * stays in view (frozen by default) as the grid scrolls.
 */
export function orderColumns<T extends { name: string; isPrimary?: boolean }>(
  columns: readonly T[],
  fieldOrder: readonly string[] | undefined,
): T[] {
  const order = fieldOrder ?? [];
  const byName = new Map(columns.map((column) => [column.name, column]));
  const list = [
    ...order
      .map((name) => byName.get(name))
      .filter((column): column is T => Boolean(column)),
    ...columns.filter((column) => !order.includes(column.name)),
  ];
  const primary = list.find((column) => column.isPrimary);
  return primary
    ? [primary, ...list.filter((column) => column !== primary)]
    : list;
}

/** Columns not listed in the view's hidden fields; the primary never hides. */
export function visibleColumns<T extends { name: string; isPrimary?: boolean }>(
  columns: readonly T[],
  hiddenFields: readonly string[] | undefined,
): T[] {
  const hidden = new Set(hiddenFields ?? []);
  return columns.filter(
    (column) => column.isPrimary || !hidden.has(column.name),
  );
}

/** Columns frozen when the view sets none: the primary field. */
export const DEFAULT_FROZEN = 1;
