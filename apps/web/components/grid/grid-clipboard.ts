import {
  coerceCellValue,
  decimalSeries,
  isDecimalString,
  parseDelimited,
} from "@anygriddb/core";
import { cellDisplay } from "../../lib/format";
import type { CatalogColumn, Collaborator, RowItem } from "../../lib/types";
import { isComputedField, isLinkField } from "../fields/field-meta";
import type { CellValue } from "../table/table-context";

export function isEditableColumn(column: CatalogColumn): boolean {
  return (
    !isComputedField(column.fieldType) &&
    !isLinkField(column.fieldType) &&
    !column.error &&
    column.access !== "read"
  );
}

/** A link the reader may change: field rules can make it read-only. */
export function isEditableLink(column: CatalogColumn): boolean {
  return Boolean(column.relation) && column.access !== "read";
}

/**
 * What a spreadsheet would run as a formula if a cell began with it, and
 * the apostrophes already in front of it.
 */
const FORMULA_START = /^'*[=+\-@\t\r]/;
/** A cell with an apostrophe in front of such a start. */
const GUARDED = /^'+[=+\-@\t\r]/;
/** A number, signed or not: digits and their separators, never a formula. */
const PLAIN_NUMBER = /^[+-]?\d[\d.,\s]*$/;

/**
 * A cell that would be read as a formula gets an apostrophe in front, so
 * a spreadsheet shows it instead of running it. Numbers stay numbers. A
 * cell that already has one gets another, so pasting it back gives the
 * same text.
 */
function tsvCell(text: string): string {
  const guarded =
    FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
  return /[\t\n"]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** A pasted cell without the apostrophe `tsvCell` put in front of it. */
function unguarded(cell: string): string {
  return GUARDED.test(cell) ? cell.slice(1) : cell;
}

/** Selected cells as tab-separated text, quoting cells with tabs, newlines, or quotes. */
export function toTsv(
  rows: readonly RowItem[],
  columns: readonly CatalogColumn[],
  locale: "fr" | "en",
  people: ReadonlyMap<string, Collaborator>,
): string {
  return rows
    .map((row) =>
      columns
        .map((column) => {
          const value = row[column.name as keyof RowItem];
          if (column.fieldType === "user" && Array.isArray(value)) {
            return tsvCell(
              value
                .map((id) => people.get(String(id))?.displayName ?? "")
                .join(", "),
            );
          }
          if (
            (column.fieldType === "date" || column.fieldType === "datetime") &&
            typeof value === "string"
          ) {
            return tsvCell(column.fieldType === "date" ? value : value);
          }
          return tsvCell(cellDisplay(value, column, locale, people));
        })
        .join("\t"),
    )
    .join("\n");
}

/**
 * Parses clipboard text into a matrix. A single cell may contain anything.
 * What `toTsv` guarded comes back as it was in the grid.
 */
export function parseClipboard(text: string): string[][] {
  return clipboardCells(text).map((row) => row.map(unguarded));
}

function clipboardCells(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (!normalized.includes("\t") && !normalized.includes("\n")) {
    return [[normalized]];
  }
  try {
    const rows = parseDelimited(`${normalized}\n`, {
      delimiter: "\t",
      maxBytes: 5_000_000,
      maxRows: 5_001,
      maxColumns: 500,
      minRows: 1,
    });
    return rows;
  } catch {
    return normalized.split("\n").map((line) => line.split("\t"));
  }
}

export type PastePlan = {
  updates: Array<{ rowId: string; values: Record<string, CellValue> }>;
  inserts: Array<Record<string, CellValue>>;
  skipped: number;
};

/**
 * Maps a pasted matrix onto rows and columns starting at the active cell.
 * A single value fills the whole selected range. Cells that do not fit
 * their column type are skipped and counted.
 */
export function planPaste(input: {
  matrix: string[][];
  rows: readonly RowItem[];
  columns: readonly CatalogColumn[];
  startRow: number;
  startColumn: number;
  range?: { rows: number; columns: number };
  resolveUser: (text: string) => string | undefined;
}): PastePlan {
  const { matrix, rows, columns, startRow, startColumn } = input;
  const single = matrix.length === 1 && matrix[0]?.length === 1;
  const height = single && input.range ? input.range.rows : matrix.length;
  const width =
    single && input.range
      ? input.range.columns
      : Math.max(...matrix.map((line) => line.length));
  const updates = new Map<string, Record<string, CellValue>>();
  const inserts: Array<Record<string, CellValue>> = [];
  let skipped = 0;
  for (let r = 0; r < height; r += 1) {
    const source = single ? matrix[0] : matrix[r];
    const target = rows[startRow + r];
    const values: Record<string, CellValue> = {};
    for (let c = 0; c < width; c += 1) {
      const column = columns[startColumn + c];
      if (!column) continue;
      const raw = single ? (source?.[0] ?? "") : (source?.[c] ?? "");
      if (!isEditableColumn(column)) {
        if (raw !== "") skipped += 1;
        continue;
      }
      const value = coerceCellValue(
        { fieldType: column.fieldType, config: column.config },
        raw,
        { resolveUser: input.resolveUser },
      );
      if (value === undefined) {
        skipped += 1;
        continue;
      }
      values[column.name] = value;
    }
    if (Object.keys(values).length === 0) continue;
    if (target) {
      updates.set(target.id, { ...(updates.get(target.id) ?? {}), ...values });
    } else {
      inserts.push(values);
    }
  }
  return {
    updates: [...updates.entries()].map(([rowId, values]) => ({
      rowId,
      values,
    })),
    inserts,
    skipped,
  };
}

/** Values for a fill handle drag: repeats the source, or extends a numeric series. */
export function fillValues(
  source: readonly CellValue[],
  count: number,
): CellValue[] {
  // Exact numbers come as decimal text: they extend exactly (ADR 0023).
  const decimals = source.filter((value): value is string =>
    isDecimalString(value),
  );
  if (source.length >= 2 && decimals.length === source.length) {
    return decimalSeries(
      decimals[decimals.length - 2] ?? "0",
      decimals[decimals.length - 1] ?? "0",
      count,
    );
  }
  const numbers = source.filter(
    (value): value is number => typeof value === "number",
  );
  if (source.length >= 2 && numbers.length === source.length) {
    const step =
      (numbers[numbers.length - 1] ?? 0) - (numbers[numbers.length - 2] ?? 0);
    const last = numbers[numbers.length - 1] ?? 0;
    return Array.from(
      { length: count },
      (_, index) => last + step * (index + 1),
    );
  }
  return Array.from(
    { length: count },
    (_, index) => source[index % Math.max(source.length, 1)] ?? null,
  );
}
