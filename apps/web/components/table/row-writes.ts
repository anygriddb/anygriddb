import { toWriteValue } from "../../lib/format";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { isEditableColumn } from "../grid/grid-clipboard";
import type { CellValue } from "./table-context";

export type CellUpdate = { rowId: string; values: Record<string, CellValue> };

/** Each value as its field's type writes it. */
export function writeValues(
  updates: readonly CellUpdate[],
  columns: readonly CatalogColumn[],
): CellUpdate[] {
  const types = new Map(
    columns.map((column) => [column.name, column.fieldType]),
  );
  return updates.map((update) => ({
    rowId: update.rowId,
    values: Object.fromEntries(
      Object.entries(update.values).map(([key, value]) => [
        key,
        toWriteValue(types.get(key) ?? "text", value),
      ]),
    ),
  }));
}

/** The fields a batch of updates changes, each named once. */
export function touchedFields(updates: readonly CellUpdate[]): string[] {
  return [...new Set(updates.flatMap((update) => Object.keys(update.values)))];
}

/**
 * What the rows hold in the fields an update changes: what undoing it
 * writes back, and what a client's table is asked to still hold.
 */
export function valuesBefore(
  updates: readonly CellUpdate[],
  rowsById: ReadonlyMap<string, RowItem>,
): CellUpdate[] {
  return updates.map((update) => {
    const row = rowsById.get(update.rowId);
    return {
      rowId: update.rowId,
      values: Object.fromEntries(
        Object.keys(update.values).map((key) => [
          key,
          (row?.[key as keyof RowItem] ?? null) as CellValue,
        ]),
      ),
    };
  });
}

/** The ids of the rows a link cell holds. */
export function linkedIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) =>
        item && typeof item === "object" && "id" in item
          ? [String(item.id)]
          : [],
      )
    : [];
}

/** What a copy of each row holds: the values of its editable fields. */
export function rowCopies(
  rowIds: readonly string[],
  rowsById: ReadonlyMap<string, RowItem>,
  columns: readonly CatalogColumn[],
): Array<Record<string, CellValue>> {
  const editable = columns.filter((column) => isEditableColumn(column));
  return rowIds.flatMap((id) => {
    const row = rowsById.get(id);
    if (!row) return [];
    return [
      Object.fromEntries(
        editable.map((column) => [
          column.name,
          (row[column.name as keyof RowItem] ?? null) as CellValue,
        ]),
      ),
    ];
  });
}

/** The row that comes last in the view's order: its copies go under it. */
export function lastInOrder(
  rowIds: readonly string[],
  loaded: readonly RowItem[],
): string | undefined {
  const order = new Map(loaded.map((row, index) => [row.id, index]));
  return [...rowIds].sort(
    (a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1),
  )[rowIds.length - 1];
}
