import { Readable } from "node:stream";
import {
  AppError,
  detectDelimiter,
  type ImportFormat,
  inferFieldType,
  type InferredField,
  parseDelimited,
} from "@anygriddb/core";
import ExcelJS from "exceljs";

export const IMPORT_LIMITS = {
  /** Text formats; a spreadsheet is compressed, so it gets less. */
  maxBytes: 20 * 1024 * 1024,
  maxXlsxBytes: 10 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 200,
  maxCell: 20_000,
} as const;

export const PREVIEW_ROWS = 20;
const INFER_SAMPLE = 1_000;

export type ParsedSheet = { headers: string[]; rows: string[][] };

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

function finish(headerRow: readonly string[], body: string[][]): ParsedSheet {
  if (headerRow.length === 0 || headerRow.length > IMPORT_LIMITS.maxColumns) {
    throw new AppError("invalid_import");
  }
  if (body.length > IMPORT_LIMITS.maxRows) {
    throw new AppError("too_many_rows");
  }
  const width = headerRow.length;
  const rows = body
    .map((cells) =>
      Array.from({ length: width }, (_, index) => clip(cells[index] ?? "")),
    )
    .filter((cells) => cells.some((cell) => cell.trim() !== ""));
  return { headers: cleanHeaders(headerRow), rows };
}

function decode(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function parseText(bytes: Buffer, format: "csv" | "tsv"): ParsedSheet {
  const text = decode(bytes);
  let records: string[][];
  try {
    records = parseDelimited(text, {
      delimiter: format === "tsv" ? "\t" : detectDelimiter(text),
      maxBytes: IMPORT_LIMITS.maxBytes,
      maxRows: IMPORT_LIMITS.maxRows + 1,
      maxColumns: IMPORT_LIMITS.maxColumns,
      minRows: 1,
      ragged: true,
    });
  } catch (error) {
    throw new AppError("invalid_import", { cause: error });
  }
  const [headers, ...body] = records;
  if (!headers) {
    throw new AppError("invalid_import");
  }
  return finish(headers, body);
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
function parseJson(bytes: Buffer): ParsedSheet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(bytes));
  } catch (error) {
    throw new AppError("invalid_import", { cause: error });
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as { records?: unknown; rows?: unknown }).records ??
        (parsed as { rows?: unknown }).rows)
      : undefined;
  if (!Array.isArray(list) || list.length > IMPORT_LIMITS.maxRows) {
    throw new Error(Array.isArray(list) ? "Too many rows" : "Invalid import");
  }
  const keys: string[] = [];
  const records = list.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AppError("invalid_import");
    }
    // REST-style `{id, fields: {...}}` records import their fields.
    const fields = (item as { fields?: unknown }).fields;
    const record =
      fields && typeof fields === "object" && !Array.isArray(fields)
        ? (fields as Record<string, unknown>)
        : (item as Record<string, unknown>);
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) {
        if (keys.length >= IMPORT_LIMITS.maxColumns) {
          throw new AppError("invalid_import");
        }
        keys.push(key);
      }
    }
    return record;
  });
  return finish(
    keys,
    records.map((record) => keys.map((key) => jsonText(record[key]))),
  );
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
 * Streams the first worksheet and stops past the row limit, so a large
 * sheet is refused without being held in memory.
 */
async function parseXlsx(bytes: Buffer): Promise<ParsedSheet> {
  if (bytes.length > IMPORT_LIMITS.maxXlsxBytes) {
    throw new AppError("invalid_import");
  }
  const rows: string[][] = [];
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(
      Readable.from(bytes),
      {
        sharedStrings: "cache",
        styles: "cache",
        hyperlinks: "ignore",
        worksheets: "emit",
        entries: "emit",
      },
    );
    for await (const sheet of reader) {
      for await (const row of sheet) {
        if (row.number > IMPORT_LIMITS.maxRows + 1) {
          throw new AppError("too_many_rows");
        }
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        if (values.length > IMPORT_LIMITS.maxColumns + 50) {
          throw new AppError("invalid_import");
        }
        // Rows keep their position: a blank row inside the sheet stays blank.
        while (rows.length < row.number - 1) rows.push([]);
        rows.push(Array.from(values, (value) => excelText(value)));
      }
      break;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Too many rows") {
      throw error;
    }
    throw new AppError("invalid_import", { cause: error });
  }
  const start = rows.findIndex((cells) =>
    cells.some((cell) => cell.trim() !== ""),
  );
  if (start < 0) {
    throw new AppError("invalid_import");
  }
  const [headerRow = [], ...body] = rows.slice(start);
  let width = headerRow.length;
  while (width > 0 && (headerRow[width - 1] ?? "").trim() === "") width -= 1;
  for (const cells of body) {
    let used = cells.length;
    while (used > width && (cells[used - 1] ?? "").trim() === "") used -= 1;
    width = Math.max(width, used);
  }
  return finish(
    Array.from({ length: width }, (_, index) => headerRow[index] ?? ""),
    body,
  );
}

export async function parseImportFile(
  format: ImportFormat,
  bytes: Buffer,
): Promise<ParsedSheet> {
  if (bytes.length === 0 || bytes.length > IMPORT_LIMITS.maxBytes) {
    throw new AppError("invalid_import");
  }
  switch (format) {
    case "csv":
    case "tsv":
      return parseText(bytes, format);
    case "json":
      return parseJson(bytes);
    case "xlsx":
      return parseXlsx(bytes);
  }
}

export type ImportPreview = {
  headers: string[];
  sample: string[][];
  total: number;
  inferred: InferredField[];
};

export function previewSheet(sheet: ParsedSheet): ImportPreview {
  const sample = sheet.rows.slice(0, INFER_SAMPLE);
  return {
    headers: sheet.headers,
    sample: sheet.rows.slice(0, PREVIEW_ROWS),
    total: sheet.rows.length,
    inferred: sheet.headers.map((_, index) =>
      inferFieldType(sample.map((cells) => cells[index] ?? "")),
    ),
  };
}
