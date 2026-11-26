import {
  AppError,
  cellText,
  type CellValue,
  type ColumnDefinition,
  type DayOrder,
  type DecimalMark,
  type EngineCatalog,
  holdsUnwritableText,
  IMPORT_FORMATS,
  type ImportCommitInput,
  isBlankCell,
  isFormulaGuarded,
  MAX_READ_LIMIT,
  OPTION_COLORS,
  readCellValue,
  resolveChangeReason,
  type SelectOption,
  type WriteColumn,
  ceilingOf,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FileStore } from "../files/index.js";
import { z } from "zod";
import type { SheetRow, SheetShape } from "../import-file.js";
import { MAX_COPY_ROWS, readAll } from "./data-ops.js";
import { loadEngine, type TableRow } from "./engine.js";
import { readPage, writeColumns, type WriteContext } from "./rows.js";
import { insertNativeBatch, updateNativeBatch } from "../services/rows.js";
import { addColumn, updateColumn } from "./schema-ops.js";
import type { SummaryEvent } from "../queue/jobs.js";
import {
  insertExternalRows,
  updateExternalRows,
  type ExternalWriteContext,
} from "../sources/writes.js";
import {
  copyStagedUpload,
  dropStagedUpload,
  keepStagedUpload,
  stageUploadFile,
} from "./staged-uploads.js";

const IMPORT_TTL_SECONDS = ceilingOf("retention.staged_import_seconds");
const MAX_ERRORS = ceilingOf("import.errors_listed");
const MAX_OPTIONS = ceilingOf("import.options_added");
/** How long an import's event waits for the next batch to update it. */
const IMPORT_EVENT_DELAY_MS = 30_000;
/** Rows read, checked, and written together. */
export const IMPORT_BATCH = 500;
/** Rows a client's database takes in one transaction during an import. */
const CLIENT_BATCH = 100;

const shapeSchema = z.object({
  format: z.enum(IMPORT_FORMATS),
  headers: z.array(z.string().max(100)).min(1).max(200),
  delimiter: z.enum([",", ";", "\t"]).optional(),
  headerLine: z.int().min(0),
  total: z.int().min(0),
  encoding: z.literal("windows-1252").optional(),
});

/** A file waiting for its import: whose it is, and how to read it. */
type StagedImport = {
  id: string;
  userId: string;
  filename: string;
  size: number;
  shape: SheetShape;
};

/**
 * Keeps an uploaded file until the user confirms the mapping (ADR 0064):
 * the file as it came, and what its first pass found.
 */
export async function stageImport(
  db: Database,
  files: FileStore,
  input: {
    userId: string;
    filename: string;
    path: string;
    size: number;
    shape: SheetShape;
  },
): Promise<string> {
  return stageUploadFile(db, files, {
    userId: input.userId,
    kind: "import",
    filename: input.filename,
    path: input.path,
    size: input.size,
    contentType: "application/octet-stream",
    ttlSeconds: IMPORT_TTL_SECONDS,
    meta: input.shape,
  });
}

/** Only the user who uploaded the file can read it back, while it is kept. */
export async function loadStagedImport(
  db: Database,
  id: string,
  userId: string,
): Promise<StagedImport> {
  const row = /^[0-9a-f-]{36}$/.test(id)
    ? await db
        .selectFrom("stagedUploads")
        .select(["id", "userId", "filename", "size", "meta"])
        .where("id", "=", id)
        .where("userId", "=", userId)
        .where("kind", "=", "import")
        .where("expiresAt", ">", new Date())
        .executeTakeFirst()
    : undefined;
  const shape = shapeSchema.safeParse(row?.meta);
  if (!row || !shape.success) {
    throw new AppError("unknown_import");
  }
  return {
    id: row.id,
    userId: row.userId,
    filename: row.filename,
    size: row.size,
    shape: shape.data,
  };
}

/** Copies the staged file to `path`, for its job to read. */
export async function copyStagedImport(
  db: Database,
  files: FileStore,
  staged: StagedImport,
  path: string,
): Promise<void> {
  const copied = await copyStagedUpload(db, files, {
    id: staged.id,
    userId: staged.userId,
    kind: "import",
    maxBytes: staged.size,
    path,
  });
  if (!copied) throw new AppError("unknown_import");
}

/** A queued import keeps its file for two hours, enough to wait its turn. */
const IMPORT_JOB_TTL_SECONDS = ceilingOf("retention.queued_import_seconds");

export async function keepStagedImport(
  db: Database,
  id: string,
): Promise<void> {
  await keepStagedUpload(db, id, IMPORT_JOB_TTL_SECONDS);
}

export async function dropStagedImport(
  db: Database,
  files: FileStore,
  id: string,
): Promise<void> {
  await dropStagedUpload(db, files, id);
}

/** A file's data rows, read in batches, as many times as asked. */
export type ImportSource = {
  headers: readonly string[];
  /** Data rows in the file, for progress. */
  total: number;
  /** The rows from the first, `IMPORT_BATCH` at a time. */
  batches(): AsyncIterable<SheetRow[]>;
};

/** Rows held in memory, numbered as a file's lines under its header. */
export function rowsSource(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): ImportSource {
  const lines = rows.flatMap((cells, index) =>
    cells.some((cell) => cell.trim() !== "")
      ? [{ line: index + 2, cells: [...cells] }]
      : [],
  );
  return {
    headers,
    total: lines.length,
    async *batches() {
      for (let start = 0; start < lines.length; start += IMPORT_BATCH) {
        await Promise.resolve();
        yield lines.slice(start, start + IMPORT_BATCH);
      }
    },
  };
}

function splitValues(text: string, multiple: boolean): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  return multiple
    ? trimmed
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter((item) => item !== "")
    : [trimmed];
}

/**
 * A select's value without the apostrophe an export put before a formula
 * sign, unless an option really is written with it.
 */
function unguardedChoice(
  raw: string,
  options: readonly SelectOption[],
): string {
  return isFormulaGuarded(raw) && !options.some((option) => option.name === raw)
    ? raw.slice(1)
    : raw;
}

/**
 * A cell as its field reads it. The apostrophe a CSV export puts before a
 * formula sign goes for a field that checks what it holds; in a text it
 * may be the text itself, and goes only when the import was told so.
 */
function unguardedCell(
  column: WriteColumn,
  raw: string,
  stripText: boolean,
): string {
  if (!isFormulaGuarded(raw)) return raw;
  if (column.fieldType === "text" || column.fieldType === "long_text") {
    return stripText ? raw.slice(1) : raw;
  }
  return isSelect(column.fieldType)
    ? unguardedChoice(raw, column.config.options ?? [])
    : raw.slice(1);
}

/**
 * Options to add so every value of a select column is known, found one
 * value at a time, with colours continuing after the existing ones. Names
 * compare without case, like the coercion does; past 200 options, the
 * rest is left out.
 */
class OptionFinder {
  readonly added: SelectOption[] = [];
  private readonly known: Set<string>;

  constructor(
    private readonly existing: readonly SelectOption[],
    private readonly multiple: boolean,
  ) {
    this.known = new Set(existing.map((option) => option.name.toLowerCase()));
  }

  add(value: string): void {
    const text = unguardedChoice(value, this.existing);
    for (const name of splitValues(text, this.multiple)) {
      const clipped = name.slice(0, 80);
      // Its row is refused; an option holding it could not be saved.
      if (holdsUnwritableText(clipped)) continue;
      if (this.known.has(clipped.toLowerCase())) continue;
      if (this.existing.length + this.added.length >= MAX_OPTIONS) return;
      this.known.add(clipped.toLowerCase());
      this.added.push({
        name: clipped,
        color:
          OPTION_COLORS[
            (this.existing.length + this.added.length) % OPTION_COLORS.length
          ] ?? "gray",
      });
    }
  }
}

export function missingOptions(
  existing: readonly SelectOption[],
  values: Iterable<string>,
  multiple: boolean,
): SelectOption[] {
  const finder = new OptionFinder(existing, multiple);
  for (const value of values) finder.add(value);
  return finder.added;
}

function isSelect(fieldType: string): boolean {
  return fieldType === "single_select" || fieldType === "multi_select";
}

/**
 * Column definitions for the mapped source columns to create. A select
 * takes the options found in the file, or one to start from: the import
 * adds the rest when it runs.
 */
export function newTableColumns(
  mapping: ImportCommitInput["mapping"],
  found: ReadonlyMap<number, readonly SelectOption[]> = new Map(),
): ColumnDefinition[] {
  return mapping.flatMap((entry) => {
    if (!entry.create) return [];
    const definition: ColumnDefinition = {
      label: entry.create.label,
      fieldType: entry.create.fieldType,
    };
    if (isSelect(entry.create.fieldType)) {
      const options = found.get(entry.source) ?? [];
      definition.config = {
        options:
          options.length > 0
            ? [...options]
            : [{ name: "Option", color: "gray" }],
      };
    }
    return [definition];
  });
}

/** Reads the file once for the options its select columns need. */
async function findOptions(
  source: ImportSource,
  finders: ReadonlyMap<number, OptionFinder>,
): Promise<void> {
  if (finders.size === 0) return;
  for await (const batch of source.batches()) {
    for (const row of batch) {
      for (const [index, finder] of finders) {
        finder.add(row.cells[index] ?? "");
      }
    }
  }
}

/** The rows among `rowIds` that a row rule keeps out of `scope`. */
async function outsideRowRule(
  db: Database,
  scope: EngineCatalog | undefined,
  rowIds: readonly string[],
): Promise<Set<string>> {
  if (!scope?.access?.rowFilter(scope.table.id) || rowIds.length === 0) {
    return new Set();
  }
  const inside = new Set<string>();
  for (let start = 0; start < rowIds.length; start += MAX_READ_LIMIT) {
    const chunk = rowIds.slice(start, start + MAX_READ_LIMIT);
    const page = await readPage(
      db,
      scope,
      { rowIds: chunk, limit: chunk.length, fields: [] },
      { total: false },
    );
    for (const row of page.rows) inside.add(row.id);
  }
  return new Set(rowIds.filter((id) => !inside.has(id)));
}

type ImportError = {
  /** Line in the source file, the header being line 1. */
  line: number;
  column: string;
  value: string;
  message: "Invalid value" | "Row locked" | "Refused";
  /** What a client's database refused (ADR 0028), as an error code. */
  code?: string;
  detail?: string;
};

/** A line whose key a later line of the file wrote again. */
type ReplacedLine = { line: number; by: number; key: string };

type ImportResult = {
  tableId: string;
  inserted: number;
  updated: number;
  failed: number;
  errors: ImportError[];
  createdColumns: number;
  /** Lines replaced by a later one with the same key: the last one wins. */
  replaced: number;
  /** The first of them, each with the line that replaced it. */
  replacedLines: ReplacedLine[];
  /** Formula cells with no stored value, left empty. */
  emptyFormulas: number;
};

/**
 * A value quoted in a report, which is kept as JSON: a NUL is shown by its
 * picture, and a character cut in two by the replacement mark.
 */
function reportedText(text: string): string {
  return Buffer.from(text.replaceAll("\0", "\u2400")).toString();
}

/**
 * Writes a file into a table as it is read (ADR 0064). Columns to create
 * are added first and select options found when they are needed, which
 * reads the file once before; then each batch of rows is coerced, checked
 * and written in its own transaction. A row with a bad cell is skipped and
 * reported on its line; the others are inserted, or updated when
 * `upsertSource` finds a row with the same value, in the table or among
 * the rows this import wrote.
 */
export async function importIntoTable(
  db: Database,
  input: {
    userId: string;
    table: TableRow;
    source: ImportSource;
    mapping: ImportCommitInput["mapping"];
    upsertSource?: number;
    addOptions: boolean;
    canManage: boolean;
    reason?: string;
    resolveUser?: (text: string) => string | undefined;
    /** What the file's numbers use for decimals, when its reader said. */
    decimalMark?: DecimalMark;
    /** Which comes first in the file's dates, when its reader said. */
    dayOrder?: DayOrder;
    /** Where a day alone starts, in a field with no zone of its own. */
    timeZone?: string;
    /** Columns already created with the table, in mapping order. */
    created?: readonly string[];
    /** Called after each batch with the lines read so far. */
    onProgress?: (done: number, total: number) => Promise<void>;
    /** Called once rows are committed, with how many so far. */
    onWritten?: (written: { inserted: number; updated: number }) => void;
    /** Take off a CSV export's apostrophe in text fields too. */
    stripTextGuard?: boolean;
    /** Names this import's one event; each batch updates its count. */
    eventKey: string;
    /**
     * The importer's reading of the table, with their row rule: a line
     * that would write or reach a row outside it is refused on its number.
     */
    rowScope?: EngineCatalog;
  },
): Promise<ImportResult> {
  const { source, table } = input;
  if (input.mapping.some((entry) => entry.source >= source.headers.length)) {
    throw new AppError("invalid_mapping");
  }
  let { engine, rows: catalog } = await loadEngine(db, table.id, () => true);
  const external = table.storage === "external";
  const importable = () =>
    new Map(
      [
        ...writeColumns(engine),
        // A client's link is its own foreign key: imported as the key it
        // holds (ADR 0006).
        ...(external ? foreignKeys(engine) : []),
      ].map((column) => [column.name, column]),
    );

  // Which columns take which source, and which options the file must give.
  const targets = new Map<number, string>();
  const toCreate: Array<ImportCommitInput["mapping"][number]> = [];
  const precreated = new Map<number, string>();
  let createdIndex = 0;
  for (const entry of input.mapping) {
    if (entry.column) {
      targets.set(entry.source, entry.column);
    } else if (entry.create) {
      if (input.created) {
        const name = input.created[createdIndex];
        createdIndex += 1;
        if (!name) throw new AppError("invalid_mapping");
        targets.set(entry.source, name);
        precreated.set(entry.source, name);
      } else {
        if (!input.canManage) throw new AppError("access_denied");
        toCreate.push(entry);
      }
    }
  }
  const writable = importable();
  for (const name of targets.values()) {
    if (!writable.has(name)) {
      throw new AppError("unknown_column", name);
    }
  }
  const finders = new Map<number, OptionFinder>();
  for (const entry of toCreate) {
    if (entry.create && isSelect(entry.create.fieldType)) {
      finders.set(
        entry.source,
        new OptionFinder([], entry.create.fieldType === "multi_select"),
      );
    }
  }
  // A select made with the table holds a first option only until its
  // values are known.
  for (const [index, name] of precreated) {
    const column = writable.get(name);
    if (column && isSelect(column.fieldType)) {
      finders.set(
        index,
        new OptionFinder([], column.fieldType === "multi_select"),
      );
    }
  }
  if (input.addOptions && input.canManage) {
    for (const [index, name] of targets) {
      const column = writable.get(name);
      if (
        !column ||
        precreated.has(index) ||
        !isSelect(column.fieldType) ||
        (column.config as { preventNewOptions?: boolean }).preventNewOptions
      ) {
        continue;
      }
      finders.set(
        index,
        new OptionFinder(
          column.config.options ?? [],
          column.fieldType === "multi_select",
        ),
      );
    }
  }
  await findOptions(source, finders);

  const createdNames = [...(input.created ?? [])];
  for (const entry of toCreate) {
    const [definition] = newTableColumns(
      [entry],
      new Map([[entry.source, finders.get(entry.source)?.added ?? []]]),
    );
    if (!definition) throw new AppError("invalid_mapping");
    const column = await addColumn(db, input.userId, table.id, definition);
    createdNames.push(column.name);
    targets.set(entry.source, column.name);
  }
  let changed = toCreate.length > 0;
  for (const [index, finder] of finders) {
    const name = targets.get(index);
    const column = name ? writable.get(name) : undefined;
    if (!name || !column || finder.added.length === 0) continue;
    if (toCreate.some((entry) => entry.source === index)) continue;
    const options = precreated.has(index)
      ? finder.added
      : [...(column.config.options ?? []), ...finder.added];
    await updateColumn(db, input.userId, table, {
      name,
      config: { ...column.config, options },
    });
    changed = true;
  }
  if (changed) {
    ({ engine, rows: catalog } = await loadEngine(db, table.id, () => true));
  }
  // Keys are looked up in the whole table, so that one outside the rule is
  // refused rather than added again; what is written answers to the rule.
  const writer: EngineCatalog = input.rowScope?.access
    ? { ...engine, access: input.rowScope.access }
    : engine;
  const columns = importable();
  const own = catalog.columns.filter((column) => column.tableId === table.id);
  const reason = resolveChangeReason(own, [...targets.values()], input.reason);
  const required = own.filter((column) => column.required);

  const errors: ImportError[] = [];
  let failed = 0;
  /** Lines of the current batch that were refused. */
  const refusedLines = new Set<number>();
  const note = (error: ImportError) => {
    refusedLines.add(error.line);
    if (errors.length < MAX_ERRORS) {
      errors.push({ ...error, value: reportedText(error.value) });
    }
  };
  /** The last line that wrote each key, from one batch to the next. */
  const keyLines = new Map<string, number>();
  const replacedLines: ReplacedLine[] = [];
  let replaced = 0;
  let emptyFormulas = 0;
  /** A key written by `line`, over the `earlier` lines of its batch. */
  const settleKey = (key: string, line: number, earlier: readonly number[]) => {
    if (refusedLines.has(line)) return;
    const before = keyLines.get(key);
    for (const over of before === undefined ? earlier : [before, ...earlier]) {
      replaced += 1;
      if (replacedLines.length < MAX_ERRORS) {
        replacedLines.push({
          line: over,
          by: line,
          key: reportedText(key.slice(0, 80)),
        });
      }
    }
    keyLines.set(key, line);
  };
  const keyName =
    input.upsertSource === undefined
      ? undefined
      : targets.get(input.upsertSource);
  const keyHeader = source.headers[input.upsertSource ?? 0] ?? "";
  /** Rows found by their key: the table's, then the ones this import adds. */
  const known = new Map<
    string,
    { id: string; locked: boolean; existing: boolean }
  >();
  if (keyName) {
    const counted = await readPage(
      db,
      engine,
      { limit: 1, fields: [] },
      { total: true },
    );
    if ((counted.total ?? 0) > MAX_COPY_ROWS) {
      throw new AppError("too_many_rows");
    }
    // A client's row is locked in AnyGridDB's database (ADR 0033).
    const sealed = external ? await sealedRows(db, table.id) : new Set();
    await readAll(db, engine, [keyName], (page) => {
      for (const row of page) {
        const text = cellText(row[keyName]).trim();
        if (text !== "" && !known.has(text)) {
          known.set(text, {
            id: row.id,
            locked:
              row.ag_status === "locked" ||
              row.ag_status === "signed" ||
              sealed.has(row.id),
            existing: true,
          });
        }
      }
    });
  }
  /** A required field: a new row fills it, a change never empties it. */
  const missing = (
    values: Readonly<Record<string, CellValue>>,
    mode: "insert" | "update",
  ) =>
    required.find(
      (column) =>
        (mode === "insert" || column.name in values) &&
        isBlankCell(values[column.name]),
    );
  const refuseMissing = (line: number, column: { label: string }) => {
    failed += 1;
    note({
      line,
      column: column.label,
      value: "",
      message: "Refused",
      code: "value_required",
      detail: column.label,
    });
  };
  const refuseOutside = (item: { line: number }) => {
    failed += 1;
    note({
      line: item.line,
      column: "",
      value: "",
      message: "Refused",
      code: "row_outside_rule",
    });
  };
  const context: WriteContext = {
    userId: input.userId,
    tableId: table.id,
    physicalName: table.physicalName,
    baseId: table.baseId,
    reason,
    source: "import",
  };
  // Each batch commits on its own, with the import's event and its count
  // so far: a cancelled or interrupted import reports what it wrote.
  const batchContext = (count: number): WriteContext => ({
    ...context,
    events: {
      summary: {
        event: {
          tableId: table.id,
          event: "import",
          count,
          actorId: input.userId,
          source: "import",
        },
        key: input.eventKey,
        delayMs: IMPORT_EVENT_DELAY_MS,
      },
    },
  });

  let inserted = 0;
  let updated = 0;
  let read = 0;
  await input.onProgress?.(0, source.total);
  for await (const batch of source.batches()) {
    read += batch.length;
    refusedLines.clear();
    const valid: Array<{ line: number; values: Record<string, CellValue> }> =
      [];
    for (const row of batch) {
      emptyFormulas += row.emptyFormulas ?? 0;
      const values: Record<string, CellValue> = {};
      let ok = true;
      for (const [index, name] of targets) {
        const column = columns.get(name);
        if (!column) continue;
        const raw = row.cells[index] ?? "";
        if (row.unreadable?.includes(index)) {
          ok = false;
          note({
            line: row.line,
            column: source.headers[index] ?? "",
            value: raw.slice(0, 80),
            message: "Invalid value",
          });
          continue;
        }
        const cell = unguardedCell(column, raw, input.stripTextGuard === true);
        const reading = readCellValue(column, cell, {
          ...(input.resolveUser ? { resolveUser: input.resolveUser } : {}),
          ...(input.decimalMark ? { decimalMark: input.decimalMark } : {}),
          ...(input.dayOrder ? { dayOrder: input.dayOrder } : {}),
          ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        });
        if ("refused" in reading) {
          const { refused } = reading;
          ok = false;
          note({
            line: row.line,
            column: source.headers[index] ?? "",
            value: raw.slice(0, 80),
            message: "Invalid value",
            ...(refused.code === "invalid_cell" ? {} : { code: refused.code }),
            ...(refused.code === "value_too_long"
              ? { detail: String(refused.limit) }
              : {}),
          });
          continue;
        }
        values[name] = reading.value;
      }
      if (ok) valid.push({ line: row.line, values });
      else failed += 1;
    }

    let inserts: Array<{
      line: number;
      values: Record<string, CellValue>;
      key?: string;
    }> = [];
    let updates: Array<{
      rowId: string;
      line: number;
      values: Record<string, CellValue>;
    }> = [];
    let keyedWrites: Array<{
      key: string;
      line: number;
      earlier: readonly number[];
    }> = [];
    if (keyName) {
      // A key repeated in the file updates the same row; the last line
      // wins, and the report names the lines it replaced.
      const added = new Map<
        string,
        {
          line: number;
          values: Record<string, CellValue>;
          earlier: number[];
        }
      >();
      const changes = new Map<
        string,
        {
          line: number;
          key: string;
          existing: boolean;
          values: Record<string, CellValue>;
          earlier: number[];
        }
      >();
      for (const item of valid) {
        const text = cellText(item.values[keyName]).trim();
        if (text === "") {
          inserts.push(item);
          continue;
        }
        const match = known.get(text);
        if (!match) {
          const before = added.get(text);
          added.set(text, {
            line: item.line,
            values: { ...before?.values, ...item.values },
            earlier: before ? [...before.earlier, before.line] : [],
          });
          continue;
        }
        if (match.locked) {
          failed += 1;
          note({
            line: item.line,
            column: keyHeader,
            value: text.slice(0, 80),
            message: "Row locked",
            code: "row_locked",
          });
          continue;
        }
        const before = changes.get(match.id);
        changes.set(match.id, {
          line: item.line,
          key: text,
          existing: match.existing,
          values: { ...before?.values, ...item.values },
          earlier: before ? [...before.earlier, before.line] : [],
        });
      }
      const outside = await outsideRowRule(
        db,
        input.rowScope,
        [...changes].flatMap(([id, change]) => (change.existing ? [id] : [])),
      );
      for (const id of outside) {
        const change = changes.get(id);
        changes.delete(id);
        failed += 1;
        note({
          line: change?.line ?? 0,
          column: keyHeader,
          value: (change?.key ?? "").slice(0, 80),
          message: "Refused",
          code: "access_denied",
        });
      }
      for (const [key, item] of added) inserts.push({ ...item, key });
      updates = [...changes].map(([rowId, change]) => ({
        rowId,
        line: change.line,
        values: change.values,
      }));
      keyedWrites = [
        ...[...added].map(([key, item]) => ({
          key,
          line: item.line,
          earlier: item.earlier,
        })),
        ...[...changes.values()].map(({ key, line, earlier }) => ({
          key,
          line,
          earlier,
        })),
      ];
    } else {
      inserts = valid;
    }
    if (required.length > 0) {
      inserts = inserts.filter((item) => {
        const blank = missing(item.values, "insert");
        if (blank) refuseMissing(item.line, blank);
        return !blank;
      });
      updates = updates.filter((item) => {
        const blank = missing(item.values, "update");
        if (blank) refuseMissing(item.line, blank);
        return !blank;
      });
    }

    let ids: Array<string | undefined>;
    if (external) {
      const written = await importIntoClientTable(db, {
        context: {
          userId: input.userId,
          table,
          engine: writer,
          catalog,
          reason,
          source: "import",
          depth: 0,
        },
        inserts,
        updates,
        summary: (count) =>
          batchContext(inserted + updated + count).events as {
            summary: SummaryEvent;
          },
        report: (error) => {
          failed += 1;
          note(error);
        },
        onWritten: (more) => {
          input.onWritten?.({
            inserted: inserted + more.inserted,
            updated: updated + more.updated,
          });
        },
      });
      inserted += written.inserted;
      updated += written.updated;
      ids = written.ids;
    } else {
      ids = await writeWithinRule(
        inserts,
        async (part) => {
          const written = await insertNativeBatch(
            db,
            writer,
            batchContext(inserted + updated + part.length),
            part.map((item) => item.values),
          );
          inserted += written.length;
          input.onWritten?.({ inserted, updated });
          return written;
        },
        refuseOutside,
      );
      await writeWithinRule(
        updates,
        async (part) => {
          const written = await updateNativeBatch(
            db,
            writer,
            batchContext(inserted + updated + part.length),
            part.map(({ rowId, values }) => ({ rowId, values })),
          );
          updated += written.length;
          input.onWritten?.({ inserted, updated });
          return written;
        },
        refuseOutside,
      );
    }
    // A key this batch added finds its row in the batches after it.
    inserts.forEach((item, index) => {
      const id = ids[index];
      if (item.key !== undefined && id !== undefined) {
        known.set(item.key, { id, locked: false, existing: false });
      }
    });
    for (const { key, line, earlier } of keyedWrites) {
      settleKey(key, line, earlier);
    }
    await input.onProgress?.(read, source.total);
  }
  return {
    tableId: table.id,
    inserted,
    updated,
    failed,
    errors,
    createdColumns: createdNames.length,
    replaced,
    replacedLines,
    emptyFormulas,
  };
}

/**
 * Writes a batch in one transaction. When a row rule refuses it, nothing of
 * it was kept: its rows are written again one by one, so the lines outside
 * the rule are named and the others kept. Returns each row's id, or
 * undefined where it was refused.
 */
async function writeWithinRule<Item>(
  items: readonly Item[],
  write: (part: readonly Item[]) => Promise<string[]>,
  refuse: (item: Item) => void,
): Promise<Array<string | undefined>> {
  if (items.length === 0) return [];
  try {
    return await write(items);
  } catch (error) {
    if (!isOutsideRule(error)) throw error;
  }
  const ids: Array<string | undefined> = [];
  for (const item of items) {
    try {
      const [id] = await write([item]);
      ids.push(id);
    } catch (error) {
      if (!isOutsideRule(error)) throw error;
      refuse(item);
      ids.push(undefined);
    }
  }
  return ids;
}

function isOutsideRule(error: unknown): boolean {
  return error instanceof AppError && error.code === "row_outside_rule";
}

/** A client's foreign keys, imported as the key each one holds. */
function foreignKeys(engine: EngineCatalog): WriteColumn[] {
  return engine.table.columns
    .filter(
      (column) =>
        column.physical !== undefined &&
        column.relation?.kind === "one_to_many" &&
        column.relation.direction === "forward",
    )
    .map((column) => ({ name: column.name, fieldType: "text", config: {} }));
}

/** A client table's locked and signed rows (ADR 0033). */
async function sealedRows(db: Database, tableId: string): Promise<Set<string>> {
  const rows = await db
    .selectFrom("externalStatuses")
    .select("rowId")
    .where("tableId", "=", tableId)
    .where("status", "in", ["locked", "signed"])
    .execute();
  return new Set(rows.map((row) => row.rowId));
}

/** Rows rejected one by one: what the client refused is about the row. */
const ROW_REFUSALS =
  /^(source_value_|source_write_refused|invalid_cell|row_locked|row_outside_rule|source_conflict|source_row_missing)/;

/**
 * Writes a batch of an import to a client's table (ADR 0028), through the
 * compared, recorded write path, `CLIENT_BATCH` rows a transaction. A
 * part the client refuses is written again row by row, so the refused
 * lines are named and the others kept; a refusal that is not about a row
 * (writes off, the source down) stops the import. Returns the id of each
 * insert, or undefined where it was refused.
 */
async function importIntoClientTable(
  db: Database,
  input: {
    context: ExternalWriteContext;
    inserts: ReadonlyArray<{ values: Record<string, CellValue>; line: number }>;
    updates: ReadonlyArray<{
      rowId: string;
      values: Record<string, CellValue>;
      line: number;
    }>;
    summary: (count: number) => { summary: SummaryEvent };
    report: (error: ImportError) => void;
    /** Called once rows are committed, with this batch's count so far. */
    onWritten: (written: { inserted: number; updated: number }) => void;
  },
): Promise<{
  inserted: number;
  updated: number;
  ids: Array<string | undefined>;
}> {
  let inserted = 0;
  let updated = 0;
  const ids: Array<string | undefined> = [];
  const context = (count: number): ExternalWriteContext => ({
    ...input.context,
    summary: input.summary(count).summary,
  });
  const refused = (line: number, error: AppError) =>
    input.report({
      line,
      column: error.detail ?? "",
      value: "",
      message: "Refused",
      code: error.code,
      ...(error.detail ? { detail: error.detail } : {}),
    });
  const rowLevel = (error: unknown): error is AppError =>
    error instanceof AppError && ROW_REFUSALS.test(error.code);
  for (let index = 0; index < input.inserts.length; index += CLIENT_BATCH) {
    const part = input.inserts.slice(index, index + CLIENT_BATCH);
    try {
      const written = await insertExternalRows(
        db,
        context(inserted + updated + part.length),
        part.map((item) => item.values),
      );
      inserted += written.length;
      ids.push(...written);
      input.onWritten({ inserted, updated });
    } catch (error) {
      if (!rowLevel(error)) throw error;
      for (const item of part) {
        try {
          const [id] = await insertExternalRows(
            db,
            context(inserted + updated + 1),
            [item.values],
          );
          inserted += 1;
          ids.push(id);
          input.onWritten({ inserted, updated });
        } catch (cause) {
          if (!rowLevel(cause)) throw cause;
          refused(item.line, cause);
          ids.push(undefined);
        }
      }
    }
  }
  for (let index = 0; index < input.updates.length; index += CLIENT_BATCH) {
    const part = input.updates.slice(index, index + CLIENT_BATCH);
    try {
      updated += (
        await updateExternalRows(
          db,
          context(inserted + updated + part.length),
          part.map(({ rowId, values }) => ({ rowId, values })),
        )
      ).length;
      input.onWritten({ inserted, updated });
    } catch (error) {
      if (!rowLevel(error)) throw error;
      for (const item of part) {
        try {
          updated += (
            await updateExternalRows(db, context(inserted + updated + 1), [
              { rowId: item.rowId, values: item.values },
            ])
          ).length;
          input.onWritten({ inserted, updated });
        } catch (cause) {
          if (!rowLevel(cause)) throw cause;
          refused(item.line, cause);
        }
      }
    }
  }
  return { inserted, updated, ids };
}
