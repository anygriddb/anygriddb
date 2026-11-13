/**
 * Reads an import file from local disk as it goes (ADR 0064): a first
 * pass finds its columns, counts its rows, and keeps a sample; a second
 * hands its rows in batches, each with the line it came from. Neither
 * holds the whole file, except a JSON file, which is parsed whole.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  AppError,
  DelimitedReader,
  detectDelimiter,
  type ImportFormat,
  inferFieldType,
  type InferredField,
} from "@anygriddb/core";
import ExcelJS from "exceljs";

export const IMPORT_LIMITS = {
  /** Text formats, read as they arrive. */
  maxTextBytes: 256 * 1024 * 1024,
  /** A spreadsheet keeps its shared strings in memory while it is read. */
  maxXlsxBytes: 64 * 1024 * 1024,
  /** A JSON file is parsed whole. */
  maxJsonBytes: 20 * 1024 * 1024,
  maxColumns: 200,
  maxCell: 20_000,
} as const;

/** Rows one file may hold when the operator sets nothing (`IMPORT_MAX_ROWS`). */
export const DEFAULT_IMPORT_MAX_ROWS = 1_000_000;

export const PREVIEW_ROWS = 20;
const INFER_SAMPLE = 1_000;
/** How much of a text file is read to find its delimiter. */
const DELIMITER_PROBE = 64 * 1024;
/** Cells past the last column a row may carry, when they are empty. */
const SPARE_CELLS = 50;

/** A data row of the file, with its line: the header is line 1. */
export type SheetRow = { line: number; cells: string[] };

/**
 * What the first pass found, kept with the staged file so the second
 * reads it the same way: the columns, the delimiter of a text file, and
 * the line of a spreadsheet's header.
 */
export type SheetShape = {
  format: ImportFormat;
  headers: string[];
  delimiter?: "," | ";" | "\t";
  headerLine: number;
  /** Data rows, blank ones left out. */
  total: number;
};

export type ImportPreview = {
  headers: string[];
  sample: string[][];
  total: number;
  inferred: InferredField[];
};

const EXTENSIONS: Record<string, ImportFormat> = {
  csv: "csv",
  tsv: "tsv",
  tab: "tsv",
  txt: "csv",
  json: "json",
  xlsx: "xlsx",
};

/** Picks the format from the file extension; the content is checked by the parser. */
export function detectImportFormat(filename: string): ImportFormat {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  const format = EXTENSIONS[extension];
  if (!format) {
    throw new AppError("invalid_import");
  }
  return format;
}

/** The largest file of a format an import takes. */
export function maxImportBytes(format: ImportFormat): number {
  switch (format) {
    case "csv":
    case "tsv":
      return IMPORT_LIMITS.maxTextBytes;
    case "xlsx":
      return IMPORT_LIMITS.maxXlsxBytes;
    case "json":
      return IMPORT_LIMITS.maxJsonBytes;
  }
}

function clip(text: string): string {
  return text.length > IMPORT_LIMITS.maxCell
    ? text.slice(0, IMPORT_LIMITS.maxCell)
    : text;
}

/** Blank headers get a position name; repeated ones a counter. */
export function cleanHeaders(raw: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((value, index) => {
    const base =
      value.replace(/\s+/g, " ").trim().slice(0, 100) || `Colonne ${index + 1}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`.slice(0, 100);
  });
}

function isBlank(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim() === "");
}

/** Cells laid out under `width` columns, each clipped. */
function fit(cells: readonly string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => clip(cells[index] ?? ""));
}

/** Cells past the last trailing one that holds something. */
function usedWidth(cells: readonly string[]): number {
  let used = cells.length;
  while (used > 0 && (cells[used - 1] ?? "").trim() === "") used -= 1;
  return used;
}

/* ------------------------------------------------------------------ */
/* Records as each format gives them                                  */
/* ------------------------------------------------------------------ */

type RawRecord = { line: number; cells: string[] };

/**
 * Every record of a text file, the header first, numbered from 1. The
 * delimiter is the one given, or the first line's.
 */
async function* textRecords(
  path: string,
  format: "csv" | "tsv",
  known?: "," | ";" | "\t",
): AsyncGenerator<RawRecord & { delimiter: "," | ";" | "\t" }> {
  const stream = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: 1024 * 1024,
  });
  let reader: DelimitedReader | undefined;
  let delimiter: "," | ";" | "\t" = known ?? (format === "tsv" ? "\t" : ",");
  let head = "";
  let line = 0;
  /** The reader, once the first line has said how the file is cut. */
  const begin = (text: string): DelimitedReader => {
    if (!known && format === "csv") delimiter = detectDelimiter(text);
    const created = new DelimitedReader({
      delimiter,
      maxCell: IMPORT_LIMITS.maxCell,
      maxCells: IMPORT_LIMITS.maxColumns + SPARE_CELLS,
    });
    reader = created;
    return created;
  };
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      let records: string[][];
      if (reader) {
        records = reader.push(chunk);
      } else {
        head += chunk;
        if (!head.includes("\n") && head.length < DELIMITER_PROBE) continue;
        records = begin(head).push(head);
        head = "";
      }
      for (const cells of records) {
        line += 1;
        yield { line, cells, delimiter };
      }
    }
    let tail: string[][];
    if (reader) {
      tail = reader.end();
    } else {
      const created = begin(head);
      tail = [...created.push(head), ...created.end()];
    }
    for (const cells of tail) {
      line += 1;
      yield { line, cells, delimiter };
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "invalid_csv") {
      throw new AppError("invalid_import", { cause: error });
    }
    throw error;
  } finally {
    stream.destroy();
  }
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonText(item)).join(", ");
  }
  return JSON.stringify(value);
}

/** An array of objects, or `{records: [...]}` / `{rows: [...]}` around one. */
async function jsonRecords(
  path: string,
  maxRows: number,
): Promise<Array<Record<string, unknown>>> {
  const bytes = await readFile(path);
  if (bytes.length > IMPORT_LIMITS.maxJsonBytes) {
    throw new AppError("invalid_import");
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    parsed = JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
  } catch (error) {
    throw new AppError("invalid_import", { cause: error });
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as { records?: unknown; rows?: unknown }).records ??
        (parsed as { rows?: unknown }).rows)
      : undefined;
  if (!Array.isArray(list)) throw new AppError("invalid_import");
  if (list.length > maxRows) throw new AppError("import_too_large");
  return list.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AppError("invalid_import");
    }
    // REST-style `{id, fields: {...}}` records import their fields.
    const fields = (item as { fields?: unknown }).fields;
    return fields && typeof fields === "object" && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : (item as Record<string, unknown>);
  });
}

/** Every key the records use, in the order they first appear. */
function jsonKeys(records: ReadonlyArray<Record<string, unknown>>): string[] {
  const keys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (keys.has(key)) continue;
      if (keys.size >= IMPORT_LIMITS.maxColumns) {
        throw new AppError("invalid_import");
      }
      keys.add(key);
    }
  }
  return [...keys];
}

/** Text of one ExcelJS cell value; dates become ISO dates or date-times. */
export function excelText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const cell = value as {
      richText?: Array<{ text?: unknown }>;
      text?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((part) => excelText(part.text)).join("");
    }
    if ("result" in cell) return excelText(cell.result);
    if (typeof cell.text === "string") return cell.text;
    if (cell.error !== undefined) return "";
  }
  return "";
}

/**
 * The rows of a workbook's first worksheet that hold something, numbered
 * as the sheet numbers them.
 */
async function* workbookRecords(path: string): AsyncGenerator<RawRecord> {
  const stream = createReadStream(path);
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
      sharedStrings: "cache",
      styles: "cache",
      hyperlinks: "ignore",
      worksheets: "emit",
      entries: "emit",
    });
    for await (const sheet of reader) {
      for await (const row of sheet) {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        if (values.length > IMPORT_LIMITS.maxColumns + SPARE_CELLS) {
          throw new AppError("invalid_import");
        }
        yield {
          line: row.number,
          cells: Array.from(values, (value) => clip(excelText(value))),
        };
      }
      break;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_import", { cause: error });
  } finally {
    stream.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* First pass: columns, count, sample                                 */
/* ------------------------------------------------------------------ */

/**
 * Reads the whole file once: its columns, how many rows it holds, and its
 * first rows. Refuses a file past `maxRows` as soon as it gets there.
 */
export async function scanImportFile(
  format: ImportFormat,
  path: string,
  maxRows: number,
): Promise<{ shape: SheetShape; preview: ImportPreview }> {
  let rawHeader: string[] | undefined;
  let headerLine = 0;
  let width = 0;
  let total = 0;
  let delimiter: "," | ";" | "\t" | undefined;
  const sample: string[][] = [];
  const keep = (cells: string[]) => {
    total += 1;
    if (total > maxRows) throw new AppError("import_too_large");
    if (sample.length < INFER_SAMPLE) sample.push(cells);
  };
  switch (format) {
    case "csv":
    case "tsv":
      for await (const record of textRecords(path, format)) {
        delimiter = record.delimiter;
        if (!rawHeader) {
          rawHeader = record.cells;
          headerLine = record.line;
          width = rawHeader.length;
          continue;
        }
        if (usedWidth(record.cells) > width) {
          throw new AppError("invalid_import");
        }
        if (!isBlank(record.cells)) keep(record.cells);
      }
      break;
    case "xlsx":
      for await (const record of workbookRecords(path)) {
        if (!rawHeader) {
          if (isBlank(record.cells)) continue;
          rawHeader = record.cells;
          headerLine = record.line;
          width = usedWidth(rawHeader);
          continue;
        }
        if (isBlank(record.cells)) continue;
        width = Math.max(width, usedWidth(record.cells));
        keep(record.cells);
      }
      break;
    case "json": {
      const records = await jsonRecords(path, maxRows);
      const keys = jsonKeys(records);
      for (const record of records) {
        const cells = keys.map((key) => jsonText(record[key]));
        if (!isBlank(cells)) keep(cells);
      }
      rawHeader = keys;
      headerLine = 1;
      width = keys.length;
      break;
    }
  }
  if (!rawHeader || width === 0 || width > IMPORT_LIMITS.maxColumns) {
    throw new AppError("invalid_import");
  }
  const headers = cleanHeaders(fit(rawHeader, width));
  const rows = sample.map((cells) => fit(cells, width));
  return {
    shape: {
      format,
      headers,
      ...(delimiter ? { delimiter } : {}),
      headerLine,
      total,
    },
    preview: {
      headers,
      sample: rows.slice(0, PREVIEW_ROWS),
      total,
      inferred: headers.map((_, index) =>
        inferFieldType(rows.map((cells) => cells[index] ?? "")),
      ),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Second pass: rows in batches                                       */
/* ------------------------------------------------------------------ */

/**
 * The file's data rows, `size` at a time, read as the first pass found
 * them: under its columns, blank rows left out, each with its line.
 */
export async function* readImportFile(
  shape: SheetShape,
  path: string,
  size: number,
  maxRows: number,
): AsyncGenerator<SheetRow[]> {
  const width = shape.headers.length;
  let batch: SheetRow[] = [];
  let total = 0;
  const take = (line: number, cells: string[]): SheetRow[] | undefined => {
    if (isBlank(cells)) return undefined;
    total += 1;
    if (total > maxRows) throw new AppError("import_too_large");
    batch.push({ line, cells: fit(cells, width) });
    if (batch.length < size) return undefined;
    const full = batch;
    batch = [];
    return full;
  };
  switch (shape.format) {
    case "csv":
    case "tsv":
      for await (const record of textRecords(
        path,
        shape.format,
        shape.delimiter,
      )) {
        if (record.line <= shape.headerLine) continue;
        if (usedWidth(record.cells) > width) {
          throw new AppError("invalid_import");
        }
        const full = take(record.line, record.cells);
        if (full) yield full;
      }
      break;
    case "xlsx":
      for await (const record of workbookRecords(path)) {
        if (record.line <= shape.headerLine) continue;
        if (usedWidth(record.cells) > width) {
          throw new AppError("invalid_import");
        }
        const full = take(record.line, record.cells);
        if (full) yield full;
      }
      break;
    case "json": {
      const records = await jsonRecords(path, maxRows);
      const keys = jsonKeys(records);
      for (const [index, record] of records.entries()) {
        const full = take(
          index + 2,
          keys.map((key) => jsonText(record[key])),
        );
        if (full) yield full;
      }
      break;
    }
  }
  if (batch.length > 0) yield batch;
}
