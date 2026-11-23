import type { CatalogColumn, RowItem } from "../../lib/types";
import type { CellUpdate } from "../table/row-writes";
import type { CellValue } from "../table/table-context";
import { fillValues, isEditableColumn } from "./grid-clipboard";

/** How many rows a series typed in figures reaches: each page is a read. */
export const MAX_SERIES_ROWS = 1000;

/** What a row holds in a field, as a write takes it. */
function held(row: RowItem, column: CatalogColumn): CellValue {
  return (row[column.name as keyof RowItem] ?? null) as CellValue;
}

/**
 * Empties a range: every field of it a person fills, in each of its rows.
 * Nothing when the range holds no such field.
 */
export function clearUpdates(
  rows: readonly RowItem[],
  columns: readonly CatalogColumn[],
): CellUpdate[] {
  const targets = columns.filter(isEditableColumn);
  if (targets.length === 0) return [];
  return rows.map((row) => ({
    rowId: row.id,
    values: Object.fromEntries(targets.map((column) => [column.name, null])),
  }));
}

/**
 * Copies a range's first row down the range. A row not read yet (a hole
 * in `rows`) is skipped; with no first row there is nothing to copy.
 */
export function fillDownUpdates(
  rows: ReadonlyArray<RowItem | undefined>,
  columns: readonly CatalogColumn[],
): CellUpdate[] {
  const [source, ...below] = rows;
  if (!source) return [];
  const targets = columns.filter(isEditableColumn);
  return below.flatMap((row) =>
    row
      ? [
          {
            rowId: row.id,
            values: Object.fromEntries(
              targets.map((column) => [column.name, held(source, column)]),
            ),
          },
        ]
      : [],
  );
}

/**
 * Carries a range on over the rows under it: each field continues the
 * series its cells begin (`fillValues`), or repeats them.
 */
export function fillSeriesUpdates(
  source: readonly RowItem[],
  below: ReadonlyArray<RowItem | undefined>,
  columns: readonly CatalogColumn[],
): CellUpdate[] {
  const targets = columns.filter(isEditableColumn);
  const series = new Map(
    targets.map((column) => [
      column.name,
      fillValues(
        source.map((row) => held(row, column)),
        below.length,
      ),
    ]),
  );
  return below.flatMap((row, offset) =>
    row
      ? [
          {
            rowId: row.id,
            values: Object.fromEntries(
              targets.map((column) => [
                column.name,
                series.get(column.name)?.[offset] ?? null,
              ]),
            ),
          },
        ]
      : [],
  );
}
