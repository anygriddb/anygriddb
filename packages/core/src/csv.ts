import { AppError } from "./errors";
const FORMULA_PREFIX = /^[=+\-@]/;

export type DelimitedOptions = {
  delimiter?: "," | ";" | "\t";
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
  /** Fewest records accepted, header included. Defaults to 2. */
  minRows?: number;
  /**
   * Accept records shorter than the header, as spreadsheet exports write
   * them. A longer record is still refused unless its extra cells are empty.
   */
  ragged?: boolean;
};

/**
 * RFC 4180 style parser for comma, semicolon, or tab separated text.
 * Every record must have the header's width, unless `ragged` is set.
 */
export function parseDelimited(
  source: string,
  options: DelimitedOptions = {},
): string[][] {
  const delimiter = options.delimiter ?? ",";
  const maxBytes = options.maxBytes ?? 1_000_000;
  const maxRows = options.maxRows ?? 1001;
  const maxColumns = options.maxColumns ?? 40;
  if (source.length === 0 || source.length > maxBytes) {
    throw new AppError("invalid_csv");
  }
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text.charAt(index);
    if (quoted) {
      if (current === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
          continue;
        }
        quoted = false;
        continue;
      }
      cell += current;
      continue;
    }
    if (current === '"' && cell.length === 0) {
      quoted = true;
      continue;
    }
    if (current === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (current === "\n") {
      row.push(cell);
      rows.push(row);
      if (rows.length > maxRows) {
        throw new AppError("invalid_csv");
      }
      row = [];
      cell = "";
      continue;
    }
    if (current === "\r") {
      continue;
    }
    cell += current;
  }
  if (quoted) {
    throw new AppError("invalid_csv");
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length < (options.minRows ?? 2) || rows.length > maxRows) {
    throw new AppError("invalid_csv");
  }
  const width = rows[0]?.length ?? 0;
  if (width < 1 || width > maxColumns) {
    throw new AppError("invalid_csv");
  }
  for (const record of rows) {
    if (record.length === width) continue;
    const fits =
      options.ragged === true &&
      record.slice(width).every((extra) => extra.trim() === "");
    if (!fits) {
      throw new AppError("invalid_csv");
    }
  }
  return rows;
}

/** Guesses the delimiter from the first line: tab, semicolon, or comma. */
export function detectDelimiter(source: string): "," | ";" | "\t" {
  const firstLine = source.slice(
    0,
    source.indexOf("\n") === -1 ? undefined : source.indexOf("\n"),
  );
  const count = (char: string): number => firstLine.split(char).length - 1;
  const tabs = count("\t");
  const semicolons = count(";");
  const commas = count(",");
  if (tabs > 0 && tabs >= semicolons && tabs >= commas) return "\t";
  if (semicolons > commas) return ";";
  return ",";
}

export function parseCsv(source: string): string[][] {
  return parseDelimited(source);
}

/** Plain text of a cell for CSV and clipboard: arrays and links become comma lists. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === "object" && "label" in item
          ? cellText((item as { label: unknown }).label)
          : cellText(item),
      )
      .join(", ");
  }
  return "";
}

function escapeCell(value: unknown): string {
  const raw = cellText(value);
  const guarded = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

export function toCsv(
  headers: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  if (headers.length === 0 || headers.length > 500 || rows.length > 100_000) {
    throw new AppError("invalid_csv");
  }
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCell(row[header])).join(","));
  }
  return lines.join("\n");
}
