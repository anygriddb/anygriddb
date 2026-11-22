import { cellValueSchema, MAX_LINKS_WRITTEN } from "@anygriddb/core";
import { toWriteValue } from "../../lib/format";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { isEditableColumn } from "../grid/grid-clipboard";
import type { CellValue } from "./table-context";

export type CellUpdate = {
  rowId: string;
  values: Record<string, CellValue>;
  /**
   * What the person saw in these fields when they began the change, where
   * that is not what the page holds now: an editor left open while the row
   * was read again (ADR 0103).
   */
  seen?: Record<string, CellValue>;
};

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
 * writes back, and what the server is asked to find still there.
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

/**
 * What the person saw in the fields each update changes: what its editor
 * showed when it opened, else what the page held when they acted. Each
 * value travels as its field's type writes it, a document as its text. A
 * value too long to travel is left out: its field is then not compared.
 */
export function valuesSeen(
  given: readonly CellUpdate[],
  previous: readonly CellUpdate[],
  columns: readonly CatalogColumn[],
): Array<Record<string, CellValue>> {
  const types = new Map(
    columns.map((column) => [column.name, column.fieldType]),
  );
  return given.map((update, index) => {
    const seen: Record<string, unknown> = {
      ...previous[index]?.values,
      ...update.seen,
    };
    return Object.fromEntries(
      Object.entries(seen).flatMap(([key, value]) => {
        const sent = cellValueSchema.safeParse(
          asSeen(types.get(key) ?? "text", value),
        );
        return sent.success ? [[key, sent.data]] : [];
      }),
    );
  });
}

function asSeen(fieldType: string, value: unknown): unknown {
  if (fieldType === "json" && value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return toWriteValue(fieldType, value);
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

/**
 * How a link cell's new list travels: whole, or, past what one write can
 * name, as what changes from the list the row holds.
 */
export function linkChange(
  before: readonly string[],
  after: readonly string[],
): { targetIds: string[] } | { add: string[]; remove: string[] } {
  if (after.length <= MAX_LINKS_WRITTEN) return { targetIds: [...after] };
  const had = new Set(before);
  const wanted = new Set(after);
  return {
    add: after.filter((id) => !had.has(id)),
    remove: before.filter((id) => !wanted.has(id)),
  };
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
