import { AppError } from "./errors";
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

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

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

export type DelimitedReaderOptions = {
  delimiter: "," | ";" | "\t";
  /** Characters a cell keeps: the rest of a longer cell is dropped. */
  maxCell?: number;
  /** Cells a record may have: one more refuses the text. */
  maxCells?: number;
};

/**
 * Reads RFC 4180 style text a piece at a time, as it arrives, and hands
 * back each record once its line ends. A quote opens a quoted cell only
 * at the start of a cell; inside one, two quotes are one. Carriage
 * returns outside quotes are dropped, and a byte order mark is skipped.
 */
export class DelimitedReader {
  private readonly delimiter: number;
  private readonly maxCell: number;
  private readonly maxCells: number;
  private row: string[] = [];
  private cell = "";
  /** Characters read into the cell, kept or not. */
  private read = 0;
  private quoted = false;
  /** A quote ended the last piece inside a quoted cell: closed or doubled. */
  private quoteAtEnd = false;
  private started = false;

  constructor(options: DelimitedReaderOptions) {
    this.delimiter = options.delimiter.charCodeAt(0);
    this.maxCell = options.maxCell ?? Number.POSITIVE_INFINITY;
    this.maxCells = options.maxCells ?? Number.POSITIVE_INFINITY;
  }

  /** Reads the next piece of text; returns the records it completed. */
  push(piece: string): string[][] {
    const records: string[][] = [];
    let text = piece;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let index = 0;
    const length = text.length;
    if (this.quoteAtEnd && length > 0) {
      this.quoteAtEnd = false;
      if (text.charCodeAt(0) === QUOTE) {
        this.append('"');
        index = 1;
      } else {
        this.quoted = false;
      }
    }
    while (index < length) {
      if (this.quoted) {
        const quote = text.indexOf('"', index);
        if (quote < 0) {
          this.append(text.slice(index));
          break;
        }
        this.append(text.slice(index, quote));
        if (quote + 1 === length) {
          this.quoteAtEnd = true;
          break;
        }
        if (text.charCodeAt(quote + 1) === QUOTE) {
          this.append('"');
          index = quote + 2;
        } else {
          this.quoted = false;
          index = quote + 1;
        }
        continue;
      }
      const code = text.charCodeAt(index);
      if (code === QUOTE && this.read === 0) {
        this.quoted = true;
        index += 1;
      } else if (code === this.delimiter) {
        this.endCell();
        index += 1;
      } else if (code === LF) {
        this.endCell();
        records.push(this.row);
        this.row = [];
        index += 1;
      } else if (code === CR) {
        index += 1;
      } else {
        let next = index + 1;
        while (next < length) {
          const following = text.charCodeAt(next);
          if (
            following === this.delimiter ||
            following === LF ||
            following === CR
          ) {
            break;
          }
          next += 1;
        }
        this.append(text.slice(index, next));
        index = next;
      }
    }
    return records;
  }

  /** The last record, when the text does not end with a line break. */
  end(): string[][] {
    if (this.quoteAtEnd) {
      this.quoteAtEnd = false;
      this.quoted = false;
    }
    if (this.quoted) {
      throw new AppError("invalid_csv");
    }
    if (this.read === 0 && this.row.length === 0) return [];
    this.endCell();
    const last = this.row;
    this.row = [];
    return [last];
  }

  private append(text: string): void {
    this.read += text.length;
    const room = this.maxCell - this.cell.length;
    if (room <= 0) return;
    this.cell += text.length > room ? text.slice(0, room) : text;
  }

  private endCell(): void {
    this.row.push(this.cell);
    this.cell = "";
    this.read = 0;
    if (this.row.length > this.maxCells) {
      throw new AppError("invalid_csv");
    }
  }
}

/**
 * RFC 4180 style parser for comma, semicolon, or tab separated text.
 * Every record must have the header's width, unless `ragged` is set.
 */
export function parseDelimited(
  source: string,
  options: DelimitedOptions = {},
): string[][] {
  const maxBytes = options.maxBytes ?? 1_000_000;
  const maxRows = options.maxRows ?? 1001;
  const maxColumns = options.maxColumns ?? 40;
  if (source.length === 0 || source.length > maxBytes) {
    throw new AppError("invalid_csv");
  }
  const reader = new DelimitedReader({
    delimiter: options.delimiter ?? ",",
  });
  const rows = [...reader.push(source), ...reader.end()];
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
  const header = headers.map(escapeCell).join(",");
  const records = toCsvRows(headers, rows);
  return rows.length === 0 ? header : `${header}\n${records}`;
}

/**
 * The records alone, without the header line: one page of a file written
 * page by page.
 */
export function toCsvRows(
  headers: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  if (headers.length === 0 || headers.length > 500 || rows.length > 100_000) {
    throw new AppError("invalid_csv");
  }
  return rows
    .map((row) => headers.map((header) => escapeCell(row[header])).join(","))
    .join("\n");
}
