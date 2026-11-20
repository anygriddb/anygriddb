import { isBlankCell, rowError } from "@anygriddb/core";

/**
 * The fields a card draws of a row, each with its value: those that hold
 * something, or whose value is an error to show. A field that holds
 * nothing is left out, name and all: a name over an empty place says
 * nothing of the row. A box not ticked and a zero are values.
 */
export function drawnFields<Column extends { name: string }>(
  row: Readonly<Record<string, unknown>>,
  columns: readonly Column[],
): Array<{ column: Column; value: unknown; error: string | null }> {
  return columns.flatMap((column) => {
    const value = row[column.name];
    const error = rowError(row, column.name);
    return error === null && isBlankCell(value)
      ? []
      : [{ column, value, error }];
  });
}
