import type { CatalogColumn } from "../../lib/types";

/**
 * What a field can do for a view beyond being shown. A field AnyGridDB
 * keeps in its own database beside the rows of a live client table
 * (ADR 0046) is read once the client's database has chosen and ordered
 * the rows of a page: it cannot order them, group them, stack them, or
 * choose them by a period. The server refuses each; a screen offers a
 * field only what it can do.
 */

/** Rows can be sorted by the field. */
export function canSortBy(column: CatalogColumn): boolean {
  return !column.controlPlane;
}

/**
 * Rows can be grouped by the field: files make no group, nor does what the
 * table's engine cannot compare, which the server says of the field.
 */
export function canGroupBy(column: CatalogColumn): boolean {
  return (
    canSortBy(column) && column.fieldType !== "attachment" && !column.noGroup
  );
}

/** A kanban can stack its cards by the field: a list of one option. */
export function canStackBy(column: CatalogColumn): boolean {
  return column.fieldType === "single_select" && canGroupBy(column);
}

/** A calendar or a timeline can place rows by the field: a day or a moment. */
export function canDateBy(column: CatalogColumn): boolean {
  return (
    (column.kind === "date" || column.kind === "datetime") &&
    !column.controlPlane
  );
}

/**
 * The field a kanban stacks its cards by: the one its view names while
 * rows can be grouped by it, else the table's first list that can stack.
 */
export function stackField(
  config: { stackColumn?: unknown },
  columns: readonly CatalogColumn[],
): CatalogColumn | undefined {
  const named = columns.find((column) => column.name === config.stackColumn);
  return named && canGroupBy(named) ? named : columns.find(canStackBy);
}

/**
 * The field a calendar or a timeline places rows by: the one its view
 * names while it can, else the table's first day or moment that can.
 */
export function startField(
  config: { startColumn?: unknown },
  columns: readonly CatalogColumn[],
): CatalogColumn | undefined {
  const dated = columns.filter(canDateBy);
  return dated.find((column) => column.name === config.startColumn) ?? dated[0];
}

/** Where a timeline's bars end: the field its view names, while it can. */
export function endField(
  config: { endColumn?: unknown },
  columns: readonly CatalogColumn[],
): CatalogColumn | undefined {
  return columns
    .filter(canDateBy)
    .find((column) => column.name === config.endColumn);
}
