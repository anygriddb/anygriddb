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

/**
 * The field a field changes places with when moved one step: none past
 * either end, and none for or past the primary, which stays first.
 */
export function fieldBeside<T extends { name: string; isPrimary?: boolean }>(
  columns: readonly T[],
  index: number,
  step: -1 | 1,
): T | undefined {
  const field = columns[index];
  const other = columns[index + step];
  return field && other && !field.isPrimary && !other.isPrimary
    ? other
    : undefined;
}

/**
 * Where a field stands once dropped on another: at that field's place, or
 * just after the primary, which stays first and does not move itself.
 */
export function placeAfterMove(
  columns: ReadonlyArray<{ name: string; isPrimary?: boolean }>,
  from: string,
  to: string,
): number {
  const start = columns.findIndex((column) => column.name === from);
  const target = columns.findIndex((column) => column.name === to);
  if (start < 0 || target < 0 || columns[start]?.isPrimary) return start;
  return columns[target]?.isPrimary ? target + 1 : target;
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
