/**
 * The view a widget that shows one will show: the view chosen, or the
 * table's first while none is. A list with no empty choice shows its
 * first entry before anything is picked, so that entry is what the
 * person reads as chosen: a table with one view left nothing to pick,
 * and the widget could not be added.
 */
export function embeddedViewId(
  views: ReadonlyArray<{ id: string }>,
  chosen: string,
): string {
  return views.find((view) => view.id === chosen)?.id ?? views[0]?.id ?? "";
}

/** Rows a view's widget shows: a glance, the view itself is a click away. */
export const WIDGET_ROWS = 20;

/**
 * How many rows of its view a widget leaves out, for the line under them
 * that says so. None when the view's rows were not counted.
 */
export function rowsLeftOut(
  shown: number,
  total: number | null | undefined,
): number {
  return total === null || total === undefined ? 0 : Math.max(0, total - shown);
}

/**
 * The field a figure or a chart measures, as the catalog holds it: its
 * format is the one its sum or its mean is written in. None when the
 * widget counts rows, or when the field is gone or hidden from the reader.
 */
export function measuredColumn<Column extends { name: string }>(
  tables: ReadonlyArray<{ id: string; columns: readonly Column[] }> | undefined,
  config: Record<string, unknown>,
): Column | undefined {
  return tables
    ?.find((table) => table.id === config.tableId)
    ?.columns.find((column) => column.name === config.column);
}

/** Measures that add up: their series can stand one on another. */
const ADDITIVE = new Set([
  "count_all",
  "count_empty",
  "count_filled",
  "sum",
  "checked",
  "unchecked",
]);

/** Whether the series of a measure add up to something: a sum, a count. */
export function measureAddsUp(fn: string): boolean {
  return ADDITIVE.has(fn);
}

/**
 * How many categories a chart is asked to draw, from what was typed:
 * a whole number from 1 to `most`. Nothing typed, or no number, asks
 * for none in particular.
 */
export function categoriesAsked(typed: string, most: number): number | null {
  const asked = Number(typed.trim());
  if (typed.trim() === "" || !Number.isFinite(asked)) return null;
  return Math.min(most, Math.max(1, Math.trunc(asked)));
}
