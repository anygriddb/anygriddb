import {
  AppError,
  type EngineCatalog,
  MAX_READ_LIMIT,
  toCsv,
  toCsvRows,
} from "@anygriddb/core";
import type { RowRecord } from "./rows.js";

/** The most rows one download holds; a larger table goes through a job. */
const EXPORT_MAX_ROWS = 100_000;
/** The longest file one answer carries, in characters. */
export const EXPORT_CSV_MAX_LENGTH = 8_000_000;

/**
 * A table as CSV, read one page at a time so its rows are never all held
 * at once: the header once, then each page's records, until a page that
 * is not full.
 */
export async function exportCsv(
  engine: EngineCatalog,
  fields: readonly string[] | undefined,
  readRows: (offset: number, limit: number) => Promise<readonly RowRecord[]>,
  pageSize: number = MAX_READ_LIMIT,
): Promise<string> {
  const columns = engine.table.columns.filter(
    (column) => !fields || fields.includes(column.name),
  );
  const headers = columns.map((column) => column.label);
  let csv = toCsv(headers, []);
  for (let offset = 0; offset < EXPORT_MAX_ROWS; offset += pageSize) {
    const rows = await readRows(offset, pageSize);
    if (rows.length > 0) {
      const records = rows.map((row) =>
        Object.fromEntries(
          columns.map((column) => [column.label, row[column.name]]),
        ),
      );
      csv += `\n${toCsvRows(headers, records)}`;
      if (csv.length > EXPORT_CSV_MAX_LENGTH) {
        throw new AppError("file_too_large");
      }
    }
    if (rows.length < pageSize) break;
  }
  return csv;
}
