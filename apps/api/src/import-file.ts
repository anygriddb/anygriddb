/**
 * Reads an import file from local disk as it goes (ADR 0064): a first
 * pass finds its columns, counts its rows, and keeps a sample; a second
 * hands its rows in batches, each with the line it came from. Neither
 * holds the whole file, except a JSON file, which is parsed whole.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import {
  AppError,
  DelimitedReader,
  detectDelimiter,
  FieldGuess,
  holdsUnwritableText,
  type ImportFormat,
  inferFieldType,
  isAmbiguousDate,
  isAmbiguousNumber,
  isAmbiguousPoint,
  isFormulaGuarded,
  type InferredField,
  MAX_WORKBOOK_SHEETS,
  ceilingOf,
} from "@anygriddb/core";
import ExcelJS from "exceljs";

export const IMPORT_LIMITS = {
  /** Text formats, read as they arrive. */
  maxTextBytes: ceilingOf("import.text_bytes"),
  /** A spreadsheet keeps its shared strings in memory while it is read. */
  maxXlsxBytes: ceilingOf("import.xlsx_bytes"),
  /** A JSON file is parsed whole. */
  maxJsonBytes: ceilingOf("import.json_bytes"),
  maxColumns: 200,
  maxCell: 20_000,
} as const;

const PREVIEW_ROWS = 20;
const INFER_SAMPLE = 1_000;
/** How much of a text file is read to find its delimiter. */
const DELIMITER_PROBE = 64 * 1024;
/** Cells past the last column a row may carry, when they are empty. */
const SPARE_CELLS = 50;

/** A data row of the file, with its line: the header is line 1. */
export type SheetRow = {
  line: number;
  cells: string[];
  /** Its cells holding a formula with no stored value: they stay empty. */
  emptyFormulas?: number;
  /** Columns whose value the file cannot state: refused on this line. */
  unreadable?: number[];
};

/** How a text file's bytes are read. */
type TextEncoding = "utf-8" | "windows-1252";

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
  /** A workbook's worksheet, by its place in the file: the first if none. */
  sheet?: number;
  /** A text file that is not UTF-8. */
  encoding?: "windows-1252";
};

export type ImportPreview = {
  headers: string[];
  sample: string[][];
  total: number;
  inferred: InferredField[];
  /** Cells whose number reads two ways until the file's mark is known. */
  ambiguousNumbers: number;
  /** Cells like `1.234`, refused if the file's mark is a comma. */
  ambiguousPoints: number;
  /** Cells whose date reads two ways until the file's order is known. */
  ambiguousDates: number;
  /** The longest cell of each column, to say which fields it will not fit. */
  longest: number[];
  /** How the file's text was read: Windows-1252 is said before importing. */
  encoding: TextEncoding;
  /** Cells of each column with the apostrophe an export puts before a formula. */
  guarded: number[];
  /** Formula cells with no stored value, which stay empty. */
  emptyFormulas: number;
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

/**
 * A cell is held to one character past the most a field keeps: the memory
 * stays bounded, and a value too long is still seen as one and refused on
 * its line instead of arriving cut.
 */
const KEPT_CELL = IMPORT_LIMITS.maxCell + 1;

function clip(text: string): string {
  return text.length > KEPT_CELL ? text.slice(0, KEPT_CELL) : text;
}

const MAX_HEADER = ceilingOf("import.field_name_chars");

/** At most `length` code units, never half a character. */
function cutName(text: string, length: number): string {
  if (text.length <= length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/**
 * Blank headers get a name and their position, the name in the language of
 * the person who imports (`MadeNames.field`); repeated ones a counter.
 */
export function cleanHeaders(raw: readonly string[], blank: string): string[] {
  const taken = new Set<string>();
  return raw.map((value, index) => {
    const base =
      cutName(value.replace(/\s+/g, " ").trim(), MAX_HEADER) ||
      cutName(`${blank} ${index + 1}`, MAX_HEADER);
    let name = base;
    for (let count = 2; taken.has(name.toLowerCase()); count += 1) {
      const suffix = ` (${count})`;
      name = `${cutName(base, MAX_HEADER - suffix.length).trimEnd()}${suffix}`;
    }
    taken.add(name.toLowerCase());
    return name;
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

type RawRecord = {
  line: number;
  cells: string[];
  /** A worksheet's cells that hold a formula: their values come. */
  formulas?: number;
  /** Those with no stored value to bring. */
  emptyFormulas?: number;
};

/** Bytes Windows-1252 does not define: a file holding one is not in it. */
const UNDEFINED_IN_1252 = [0x81, 0x8d, 0x8f, 0x90, 0x9d];

/**
 * Follows a file's bytes as UTF-8 and says what it was: valid UTF-8, or
 * another encoding with no sequence of UTF-8 in it. A file holding both
 * was put together from two encodings, and neither reads all of it.
 */
class EncodingProbe {
  private needed = 0;
  private lowest = 0x80;
  private highest = 0xbf;
  private sequences = 0;
  private invalid = 0;
  private undefinedByte = false;

  push(bytes: Uint8Array): void {
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index] as number;
      if (this.needed === 0 && byte < 0x80) continue;
      if (UNDEFINED_IN_1252.includes(byte)) this.undefinedByte = true;
      if (this.needed > 0) {
        if (byte >= this.lowest && byte <= this.highest) {
          this.needed -= 1;
          this.lowest = 0x80;
          this.highest = 0xbf;
          if (this.needed === 0) this.sequences += 1;
          continue;
        }
        this.invalid += 1;
        this.needed = 0;
        this.lowest = 0x80;
        this.highest = 0xbf;
        if (byte < 0x80) continue;
      }
      if (byte >= 0xc2 && byte <= 0xdf) {
        this.needed = 1;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        this.needed = 2;
        if (byte === 0xe0) this.lowest = 0xa0;
        if (byte === 0xed) this.highest = 0x9f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        this.needed = 3;
        if (byte === 0xf0) this.lowest = 0x90;
        if (byte === 0xf4) this.highest = 0x8f;
      } else {
        this.invalid += 1;
      }
    }
  }

  /** The encoding, or nothing when no single one reads the whole file. */
  result(): TextEncoding | undefined {
    if (this.invalid === 0 && this.needed === 0) return "utf-8";
    return this.sequences === 0 && !this.undefinedByte
      ? "windows-1252"
      : undefined;
  }
}

/**
 * How a text file is encoded, read through once: UTF-8, or Windows-1252,
 * which the preview announces. UTF-16, and a file no single encoding
 * reads, are refused: nothing is replaced to make it fit.
 */
async function textEncoding(path: string): Promise<TextEncoding> {
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  const probe = new EncodingProbe();
  let first = true;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (first) {
        first = false;
        const mark = chunk.length >= 2 ? chunk.readUInt16BE(0) : 0;
        if (mark === 0xfffe || mark === 0xfeff) {
          throw new AppError("invalid_import");
        }
      }
      probe.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  const encoding = probe.result();
  if (!encoding) throw new AppError("invalid_import");
  return encoding;
}

/** The file's text, a piece at a time; a byte order mark stays in it. */
async function* decodedText(
  path: string,
  encoding: TextEncoding,
): AsyncGenerator<string> {
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      yield decoder.decode(chunk, { stream: true });
    }
    const rest = decoder.decode();
    if (rest !== "") yield rest;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AppError("invalid_import", { cause: error });
    }
    throw error;
  } finally {
    stream.destroy();
  }
}

/**
 * Every record of a text file, the header first, numbered from 1. The
 * delimiter is the one given, or the first line's.
 */
async function* textRecords(
  path: string,
  format: "csv" | "tsv",
  encoding: TextEncoding,
  known?: "," | ";" | "\t",
): AsyncGenerator<RawRecord & { delimiter: "," | ";" | "\t" }> {
  let reader: DelimitedReader | undefined;
  let delimiter: "," | ";" | "\t" = known ?? (format === "tsv" ? "\t" : ",");
  let head = "";
  let line = 0;
  /** The reader, once the first line has said how the file is cut. */
  const begin = (text: string): DelimitedReader => {
    if (!known && format === "csv") delimiter = detectDelimiter(text);
    const created = new DelimitedReader({
      delimiter,
      maxCell: KEPT_CELL,
      maxCells: IMPORT_LIMITS.maxColumns + SPARE_CELLS,
    });
    reader = created;
    return created;
  };
  try {
    for await (const chunk of decodedText(path, encoding)) {
      let records: string[][];
      if (reader) {
        records = reader.push(chunk);
      } else {
        head += chunk;
        if (!/[\r\n]/.test(head) && head.length < DELIMITER_PROBE) continue;
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
  }
}

/**
 * Numbers as the file writes them. A double would round an identifier of
 * twenty digits, in a text field too: a number whose text a double does not
 * give back is kept as that text, in a raw value that `JSON.stringify`
 * writes unchanged. The others stay numbers, which hold far less memory.
 */
type RawNumber = { readonly rawJSON: string };
const EXACT_JSON = JSON as typeof JSON & {
  rawJSON(text: string): RawNumber;
  isRawJSON(value: unknown): value is RawNumber;
};

function keepNumberText(
  _key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  return typeof value === "number" &&
    context?.source !== undefined &&
    String(value) !== context.source
    ? EXACT_JSON.rawJSON(context.source)
    : value;
}

/** A record of the file: an object, and not a number kept as written. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !EXACT_JSON.isRawJSON(value)
  );
}

/** Whether a value holds a number past what a double can say (`1e400`). */
function holdsOutOfRange(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (EXACT_JSON.isRawJSON(item)) {
      if (!Number.isFinite(Number(item.rawJSON))) return true;
    } else if (Array.isArray(item)) {
      for (const inner of item as unknown[]) pending.push(inner);
    } else if (typeof item === "object" && item !== null) {
      for (const inner of Object.values(item)) pending.push(inner);
    }
  }
  return false;
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (EXACT_JSON.isRawJSON(value)) return value.rawJSON;
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
    // JSON is UTF-8: anything else is refused, and the mark is skipped.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text, keepNumberText);
  } catch (error) {
    throw new AppError("invalid_import", { cause: error });
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isJsonObject(parsed)
      ? (parsed.records ?? parsed.rows)
      : undefined;
  if (!Array.isArray(list)) throw new AppError("invalid_import");
  if (list.length > maxRows) throw new AppError("import_too_large");
  return list.map((item: unknown) => {
    if (!isJsonObject(item)) throw new AppError("invalid_import");
    // REST-style `{id, fields: {...}}` records import their fields; a
    // record with keys of its own keeps them all.
    return isJsonObject(item.fields) &&
      Object.keys(item).every((key) => REST_RECORD_KEYS.has(key))
      ? item.fields
      : item;
  });
}

/** The keys a REST record holds around its `fields`. */
const REST_RECORD_KEYS = new Set(["id", "fields", "createdTime"]);

/** A record's cells under `keys`, and those the file cannot state. */
function jsonCells(
  record: Record<string, unknown>,
  keys: readonly string[],
): { cells: string[]; unreadable?: number[] } {
  const cells = keys.map((key) => jsonText(record[key]));
  const unreadable = keys.flatMap((key, index) =>
    holdsOutOfRange(record[key]) ? [index] : [],
  );
  return unreadable.length > 0 ? { cells, unreadable } : { cells };
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

/** A character a workbook's XML cannot hold, as the format escapes it. */
const EXCEL_ESCAPE = /_x([0-9A-Fa-f]{4})_/g;

/** Text of one ExcelJS cell value; dates become ISO dates or date-times. */
export function excelText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "string") {
    return value.replace(EXCEL_ESCAPE, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
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
    if (typeof cell.text === "string") return excelText(cell.text);
    if (cell.error !== undefined) return "";
  }
  return "";
}

/** A workbook read as it goes, its strings and styles kept for its cells. */
function workbookReader(stream: Readable): ExcelJS.stream.xlsx.WorkbookReader {
  return new ExcelJS.stream.xlsx.WorkbookReader(stream, {
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit",
    entries: "emit",
  });
}

/** A cell that holds a formula, whose value is what an import takes. */
function isFormula(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ("formula" in value || "sharedFormula" in value)
  );
}

/** A formula whose file keeps no value for it, or only an error. */
function isEmptyFormula(value: unknown): boolean {
  return isFormula(value) && excelText(value) === "";
}

/** The rows of one worksheet, numbered as the sheet numbers them. */
async function* sheetRecords(
  sheet: AsyncIterable<ExcelJS.Row>,
): AsyncGenerator<RawRecord> {
  for await (const row of sheet) {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    if (values.length > IMPORT_LIMITS.maxColumns + SPARE_CELLS) {
      throw new AppError("invalid_import");
    }
    yield {
      line: row.number,
      cells: Array.from(values, (value) => clip(excelText(value))),
      formulas: values.filter(isFormula).length,
      emptyFormulas: values.filter(isEmptyFormula).length,
    };
  }
}

/** A worksheet's name and whether its workbook hides it, as the file says. */
function aboutSheet(sheet: object): { name: string; hidden: boolean } {
  const about = sheet as { name?: unknown; state?: unknown };
  return {
    name: typeof about.name === "string" ? about.name : "",
    hidden: about.state === "hidden" || about.state === "veryHidden",
  };
}

/**
 * The rows of one worksheet of a workbook, by its place in the file (the
 * first when none is named), numbered as the sheet numbers them. The
 * worksheets before it are read through.
 */
async function* workbookRecords(
  path: string,
  sheet = 0,
): AsyncGenerator<RawRecord> {
  const stream = createReadStream(path);
  try {
    let index = 0;
    for await (const worksheet of workbookReader(stream)) {
      const records = sheetRecords(worksheet);
      if (index === sheet) {
        yield* records;
        return;
      }
      // A sheet before the one asked is read through, and nothing kept.
      while (!(await records.next()).done) {
        // The reader moves on to the next sheet once this one is read.
      }
      index += 1;
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

/** What a first pass gathers: the header, the width, the count, a sample. */
type Found = {
  rawHeader: string[] | undefined;
  headerLine: number;
  width: number;
  total: number;
  sample: string[][];
  delimiter?: "," | ";" | "\t";
  ambiguousNumbers: number;
  ambiguousPoints: number;
  ambiguousDates: number;
  longest: number[];
  guarded: number[];
  emptyFormulas: number;
  encoding: TextEncoding;
};

function nothingFound(): Found {
  return {
    rawHeader: undefined,
    headerLine: 0,
    width: 0,
    total: 0,
    sample: [],
    ambiguousNumbers: 0,
    ambiguousPoints: 0,
    ambiguousDates: 0,
    longest: [],
    guarded: [],
    emptyFormulas: 0,
    encoding: "utf-8",
  };
}

/** A data row found: counted toward the ceiling, and kept while sampling. */
function keepRow(
  found: Found,
  cells: string[],
  count: () => void,
  sampleSize: number,
): void {
  count();
  found.total += 1;
  if (found.sample.length < sampleSize) found.sample.push(cells);
  for (const [index, cell] of cells.entries()) {
    if (cell.length > (found.longest[index] ?? 0)) {
      found.longest[index] = cell.length;
    }
    if (isAmbiguousNumber(cell)) found.ambiguousNumbers += 1;
    if (isAmbiguousPoint(cell)) found.ambiguousPoints += 1;
    if (isAmbiguousDate(cell)) found.ambiguousDates += 1;
    if (isFormulaGuarded(cell)) {
      found.guarded[index] = (found.guarded[index] ?? 0) + 1;
    }
  }
}

/**
 * What a first pass found, as the shape the second reads the file by and
 * a preview. Nothing that reads as columns is refused.
 */
function scanResult(
  format: ImportFormat,
  found: Found,
  blank: string,
): { shape: SheetShape; preview: ImportPreview } {
  if (
    !found.rawHeader ||
    found.width === 0 ||
    found.width > IMPORT_LIMITS.maxColumns ||
    // A header nothing can keep: another encoding, or not text at all.
    holdsUnwritableText(found.rawHeader)
  ) {
    throw new AppError("invalid_import");
  }
  const headers = cleanHeaders(fit(found.rawHeader, found.width), blank);
  const rows = found.sample.map((cells) => fit(cells, found.width));
  return {
    shape: {
      format,
      headers,
      ...(found.delimiter ? { delimiter: found.delimiter } : {}),
      headerLine: found.headerLine,
      total: found.total,
      ...(found.encoding === "windows-1252"
        ? { encoding: found.encoding }
        : {}),
    },
    preview: {
      headers,
      sample: rows.slice(0, PREVIEW_ROWS),
      total: found.total,
      // The preview asks what a comma is and which comes first in a date:
      // a column of `1,234` is a number, one of `03/04/2026` a date.
      inferred: headers.map((_, index) =>
        inferFieldType(
          rows.map((cells) => cells[index] ?? ""),
          true,
        ),
      ),
      ambiguousNumbers: found.ambiguousNumbers,
      ambiguousPoints: found.ambiguousPoints,
      ambiguousDates: found.ambiguousDates,
      longest: headers.map((_, index) => found.longest[index] ?? 0),
      encoding: found.encoding,
      guarded: headers.map((_, index) => found.guarded[index] ?? 0),
      emptyFormulas: found.emptyFormulas,
    },
  };
}

/**
 * One worksheet's first pass: its first row that holds something is its
 * header, the rows after it that hold something are its data. With
 * `guesses`, every data cell goes to its column's guess.
 */
async function scanSheet(
  records: AsyncIterable<RawRecord>,
  count: () => void,
  sampleSize: number,
  guesses?: FieldGuess[],
): Promise<Found & { formulas: number }> {
  const found = { ...nothingFound(), formulas: 0 };
  for await (const record of records) {
    found.formulas += record.formulas ?? 0;
    const empty = record.emptyFormulas ?? 0;
    if (isBlank(record.cells) && (empty === 0 || !found.rawHeader)) continue;
    if (!found.rawHeader) {
      found.rawHeader = record.cells;
      found.headerLine = record.line;
      found.width = usedWidth(record.cells);
      continue;
    }
    found.emptyFormulas += empty;
    found.width = Math.max(found.width, usedWidth(record.cells));
    keepRow(found, record.cells, count, sampleSize);
    if (guesses) {
      for (const [index, cell] of record.cells.entries()) {
        (guesses[index] ??= new FieldGuess()).add(cell);
      }
    }
  }
  return found;
}

/** Counts the rows read, and refuses past `maxRows`. */
function rowCounter(maxRows: number): () => void {
  let counted = 0;
  return () => {
    counted += 1;
    if (counted > maxRows) throw new AppError("import_too_large");
  };
}

/**
 * Reads the whole file once: its columns, how many rows it holds, and its
 * first rows. Refuses a file past `maxRows` as soon as it gets there. A
 * blank header is named `blank` and its position.
 */
export async function scanImportFile(
  format: ImportFormat,
  path: string,
  maxRows: number,
  blank: string,
): Promise<{ shape: SheetShape; preview: ImportPreview }> {
  const count = rowCounter(maxRows);
  switch (format) {
    case "csv":
    case "tsv": {
      const found = nothingFound();
      found.encoding = await textEncoding(path);
      for await (const record of textRecords(path, format, found.encoding)) {
        found.delimiter = record.delimiter;
        if (!found.rawHeader) {
          found.rawHeader = record.cells;
          found.headerLine = record.line;
          found.width = record.cells.length;
          continue;
        }
        if (usedWidth(record.cells) > found.width) {
          throw new AppError("invalid_import");
        }
        if (!isBlank(record.cells)) {
          keepRow(found, record.cells, count, INFER_SAMPLE);
        }
      }
      return scanResult(format, found, blank);
    }
    case "xlsx":
      return scanResult(
        format,
        await scanSheet(workbookRecords(path), count, INFER_SAMPLE),
        blank,
      );
    case "json": {
      const records = await jsonRecords(path, maxRows);
      const keys = jsonKeys(records);
      const found = { ...nothingFound(), rawHeader: keys, headerLine: 1 };
      found.width = keys.length;
      for (const record of records) {
        const { cells } = jsonCells(record, keys);
        if (!isBlank(cells)) keepRow(found, cells, count, INFER_SAMPLE);
      }
      return scanResult(format, found, blank);
    }
  }
}

/** One worksheet of a workbook that holds a header, as the first pass found it. */
export type WorkbookSheet = {
  /** Its place in the file, from 0: what the second pass reads it by. */
  sheet: number;
  name: string;
  hidden: boolean;
  /** Its cells that hold a formula: their values come, not the formulas. */
  formulas: number;
  /** Those with no stored value: their cells stay empty. */
  emptyFormulas: number;
  shape: SheetShape;
  preview: ImportPreview;
};

/** Rows of each worksheet kept to infer its fields: a workbook has many. */
const WORKBOOK_SAMPLE = 200;

/**
 * Reads a workbook once, each worksheet in turn (ADR 0078): for each one
 * that holds a header, its name, its columns, how many rows and formulas
 * it holds, and a sample. Each field's type is guessed from every row of
 * its sheet, not from the sample: the rows of a new base must all fit it.
 * Refuses a workbook past `maxRows` rows in all, one with more sheets
 * than a base takes tables, or one with none.
 */
export async function scanWorkbook(
  path: string,
  maxRows: number,
  blank: string,
): Promise<WorkbookSheet[]> {
  const count = rowCounter(maxRows);
  const sheets: WorkbookSheet[] = [];
  const stream = createReadStream(path);
  try {
    let index = 0;
    for await (const worksheet of workbookReader(stream)) {
      const about = aboutSheet(worksheet);
      const guesses: FieldGuess[] = [];
      const found = await scanSheet(
        sheetRecords(worksheet),
        count,
        WORKBOOK_SAMPLE,
        guesses,
      );
      if (found.rawHeader) {
        if (sheets.length >= MAX_WORKBOOK_SHEETS) {
          throw new AppError("invalid_import");
        }
        const { shape, preview } = scanResult("xlsx", found, blank);
        sheets.push({
          sheet: index,
          name: about.name.trim().slice(0, 100) || `#${index + 1}`,
          hidden: about.hidden,
          formulas: found.formulas,
          emptyFormulas: found.emptyFormulas,
          shape: { ...shape, sheet: index },
          preview: {
            ...preview,
            inferred: shape.headers.map(
              (_, column) =>
                guesses[column]?.result() ?? { fieldType: "text" as const },
            ),
          },
        });
      }
      index += 1;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_import", { cause: error });
  } finally {
    stream.destroy();
  }
  if (sheets.length === 0) throw new AppError("invalid_import");
  return sheets;
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
  const take = (
    line: number,
    cells: string[],
    about: Pick<SheetRow, "emptyFormulas" | "unreadable"> = {},
  ): SheetRow[] | undefined => {
    if (isBlank(cells) && !about.emptyFormulas) return undefined;
    total += 1;
    if (total > maxRows) throw new AppError("import_too_large");
    batch.push({ line, cells: fit(cells, width), ...about });
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
        shape.encoding ?? "utf-8",
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
      for await (const record of workbookRecords(path, shape.sheet ?? 0)) {
        if (record.line <= shape.headerLine) continue;
        if (usedWidth(record.cells) > width) {
          throw new AppError("invalid_import");
        }
        const full = take(
          record.line,
          record.cells,
          record.emptyFormulas ? { emptyFormulas: record.emptyFormulas } : {},
        );
        if (full) yield full;
      }
      break;
    case "json": {
      const records = await jsonRecords(path, maxRows);
      const keys = jsonKeys(records);
      for (const [index, record] of records.entries()) {
        const { cells, unreadable } = jsonCells(record, keys);
        const full = take(index + 2, cells, unreadable ? { unreadable } : {});
        if (full) yield full;
      }
      break;
    }
  }
  if (batch.length > 0) yield batch;
}
