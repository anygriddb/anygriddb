import {
  AppError,
  cellText,
  type CellValue,
  coerceCellValue,
  type ColumnDefinition,
  type EngineCatalog,
  type ImportCommitInput,
  OPTION_COLORS,
  resolveChangeReason,
  type SelectOption,
  type WriteColumn,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FileStore } from "../files/index.js";
import { z } from "zod";
import type { ParsedSheet } from "../import-file.js";
import { MAX_COPY_ROWS, readAll } from "./data-ops.js";
import { loadEngine, type TableRow } from "./engine.js";
import { readPage, writeColumns, type WriteContext } from "./rows.js";
import {
  insertNativeBatch,
  updateNativeBatch,
} from "../services/rows.js";
import { addColumn, updateColumn } from "./schema-ops.js";
import type { SummaryEvent } from "../queue/jobs.js";
import {
  insertExternalRows,
  updateExternalRows,
  type ExternalWriteContext,
} from "../sources/writes.js";
import {
  dropStagedUpload,
  keepStagedUpload,
  readStagedUpload,
  stageUpload,
} from "./staged-uploads.js";

export const IMPORT_TTL_SECONDS = 30 * 60;
const MAX_ERRORS = 200;
const MAX_OPTIONS = 200;
/** How long an import's event waits for the next batch to update it. */
const IMPORT_EVENT_DELAY_MS = 30_000;
const BATCH = 500;
/** Rows a client's database takes in one transaction during an import. */
const CLIENT_BATCH = 100;

const stagedSchema = z.object({
  userId: z.uuid(),
  filename: z.string().max(255),
  headers: z.array(z.string()).max(200),
  rows: z.array(z.array(z.string())),
});

export type StagedImport = z.infer<typeof stagedSchema>;

/** A parsed file can take this much room in the file store. */
const MAX_STAGED_IMPORT_BYTES = 256 * 1024 * 1024;

/** Keeps a parsed file until the user confirms the mapping. */
export async function stageImport(
  db: Database,
  files: FileStore,
  userId: string,
  filename: string,
  sheet: ParsedSheet,
): Promise<string> {
  const staged: StagedImport = { userId, filename, ...sheet };
  return stageUpload(db, files, {
    userId,
    kind: "import",
    filename,
    body: Buffer.from(JSON.stringify(staged)),
    contentType: "application/json",
    ttlSeconds: IMPORT_TTL_SECONDS,
  });
}

/** Only the user who uploaded the file can read it back. */
export async function loadStagedImport(
  db: Database,
  files: FileStore,
  id: string,
  userId: string,
): Promise<StagedImport> {
  const upload = await readStagedUpload(db, files, {
    id,
    userId,
    kind: "import",
    maxBytes: MAX_STAGED_IMPORT_BYTES,
  });
  if (!upload) {
    throw new AppError("unknown_import");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(upload.bytes.toString("utf8"));
  } catch (error) {
    throw new AppError("unknown_import", { cause: error });
  }
  const staged = stagedSchema.safeParse(parsed);
  if (!staged.success || staged.data.userId !== userId) {
    throw new AppError("unknown_import");
  }
  return staged.data;
}

/** A queued import keeps its file for two hours, enough to wait its turn. */
export const IMPORT_JOB_TTL_SECONDS = 2 * 60 * 60;

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
 * Options to add so every value of a select column is known, with colours
 * continuing after the existing ones. Names compare without case, like the
 * coercion does.
 */
export function missingOptions(
  existing: readonly SelectOption[],
  values: Iterable<string>,
  multiple: boolean,
): SelectOption[] {
  const known = new Set(existing.map((option) => option.name.toLowerCase()));
  const added: SelectOption[] = [];
  for (const value of values) {
    for (const name of splitValues(value, multiple)) {
      const clipped = name.slice(0, 80);
      if (known.has(clipped.toLowerCase())) continue;
      if (existing.length + added.length >= MAX_OPTIONS) return added;
      known.add(clipped.toLowerCase());
      added.push({
        name: clipped,
        color:
          OPTION_COLORS[
            (existing.length + added.length) % OPTION_COLORS.length
          ] ?? "gray",
      });
    }
  }
  return added;
}

/** Column definitions for a new table built from the mapped source columns. */
export function newTableColumns(
  staged: StagedImport,
  mapping: ImportCommitInput["mapping"],
): ColumnDefinition[] {
  return mapping.flatMap((entry) => {
    if (!entry.create) return [];
    const definition: ColumnDefinition = {
      label: entry.create.label,
      fieldType: entry.create.fieldType,
    };
    if (
      entry.create.fieldType === "single_select" ||
      entry.create.fieldType === "multi_select"
    ) {
      const options = missingOptions(
        [],
        staged.rows.map((cells) => cells[entry.source] ?? ""),
        entry.create.fieldType === "multi_select",
      );
      definition.config = {
        options:
          options.length > 0 ? options : [{ name: "Option", color: "gray" }],
      };
    }
    return [definition];
  });
}

export type ImportError = {
  /** Line in the source file, the header being line 1. */
  line: number;
  column: string;
  value: string;
  message: "Invalid value" | "Row locked" | "Refused";
  /** What a client's database refused (ADR 0028), as an error code. */
  code?: string;
  detail?: string;
};

export type ImportResult = {
  tableId: string;
  inserted: number;
  updated: number;
  failed: number;
  errors: ImportError[];
  createdColumns: number;
};

/**
 * Writes a staged file into a table. Columns to create are added first,
 * unknown select values become options when `addOptions` is set and the
 * caller may manage the table, then every row is coerced. A row with a
 * bad cell is skipped and reported; the others are inserted, or updated
 * when `upsertSource` finds an existing row with the same value.
 */
export async function importIntoTable(
  db: Database,
  input: {
    userId: string;
    table: TableRow;
    staged: StagedImport;
    mapping: ImportCommitInput["mapping"];
    upsertSource?: number;
    addOptions: boolean;
    canManage: boolean;
    reason?: string;
    resolveUser?: (text: string) => string | undefined;
    /** Columns already created with the table, in mapping order. */
    created?: readonly string[];
    /** Called after each batch with the rows written so far. */
    onProgress?: (done: number, total: number) => Promise<void>;
    /** Names this import's one event; each batch updates its count. */
    eventKey: string;
  },
): Promise<ImportResult> {
  const { staged, table } = input;
  if (input.mapping.some((entry) => entry.source >= staged.headers.length)) {
    throw new AppError("invalid_mapping");
  }
  const createdNames = [...(input.created ?? [])];
  const targets = new Map<number, string>();
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
      } else {
        if (!input.canManage) throw new AppError("access_denied");
        const [definition] = newTableColumns(staged, [entry]);
        if (!definition) throw new AppError("invalid_mapping");
        const column = await addColumn(db, input.userId, table.id, definition);
        createdNames.push(column.name);
        targets.set(entry.source, column.name);
      }
    }
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
  const writable = importable();
  for (const name of targets.values()) {
    if (!writable.has(name)) {
      throw new AppError("unknown_column", name);
    }
  }

  if (input.addOptions && input.canManage) {
    let changed = false;
    for (const [source, name] of targets) {
      const column = writable.get(name);
      if (
        !column ||
        (column.fieldType !== "single_select" &&
          column.fieldType !== "multi_select")
      ) {
        continue;
      }
      if (
        (column.config as { preventNewOptions?: boolean }).preventNewOptions
      ) {
        continue;
      }
      const existing = column.config.options ?? [];
      const added = missingOptions(
        existing,
        staged.rows.map((cells) => cells[source] ?? ""),
        column.fieldType === "multi_select",
      );
      if (added.length === 0) continue;
      await updateColumn(db, input.userId, table, {
        name,
        config: { ...column.config, options: [...existing, ...added] },
      });
      changed = true;
    }
    if (changed) {
      ({ engine, rows: catalog } = await loadEngine(db, table.id, () => true));
    }
  }
  const columns = importable();
  const own = catalog.columns.filter((column) => column.tableId === table.id);
  const reason = resolveChangeReason(own, [...targets.values()], input.reason);

  const errors: ImportError[] = [];
  let failed = 0;
  const valid: Array<{ line: number; values: Record<string, CellValue> }> = [];
  staged.rows.forEach((cells, index) => {
    const values: Record<string, CellValue> = {};
    let ok = true;
    for (const [source, name] of targets) {
      const column = columns.get(name);
      if (!column) continue;
      const raw = cells[source] ?? "";
      const value = coerceCellValue(column, raw, {
        resolveUser: input.resolveUser,
      });
      if (value === undefined) {
        ok = false;
        if (errors.length < MAX_ERRORS) {
          errors.push({
            line: index + 2,
            column: staged.headers[source] ?? "",
            value: raw.slice(0, 80),
            message: "Invalid value",
          });
        }
        continue;
      }
      values[name] = value;
    }
    if (ok) valid.push({ line: index + 2, values });
    else failed += 1;
  });

  const context: WriteContext = {
    userId: input.userId,
    tableId: table.id,
    physicalName: table.physicalName,
    baseId: table.baseId,
    reason,
    source: "import",
  };
  const inserts: Array<Record<string, CellValue>> = [];
  const updates: Array<{ rowId: string; values: Record<string, CellValue> }> =
    [];
  /** The file's line of each insert and update, for what a client refuses. */
  const insertLines: number[] = [];
  const updateLines: number[] = [];
  const keyName =
    input.upsertSource === undefined
      ? undefined
      : targets.get(input.upsertSource);
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
    const existing = new Map<string, { id: string; locked: boolean }>();
    // A client's row is locked in AnyGridDB's database (ADR 0033).
    const sealed = external ? await sealedRows(db, table.id) : new Set();
    await readAll(db, engine, [keyName], (page) => {
      for (const row of page) {
        const text = cellText(row[keyName]).trim();
        if (text !== "" && !existing.has(text)) {
          existing.set(text, {
            id: row.id,
            locked:
              row.ag_status === "locked" ||
              row.ag_status === "signed" ||
              sealed.has(row.id),
          });
        }
      }
    });
    // A key repeated in the file updates the same row; the last line wins.
    const pending = new Map<string, Record<string, CellValue>>();
    const lineOf = new Map<string, number>();
    for (const item of valid) {
      const text = cellText(item.values[keyName]).trim();
      const match = text === "" ? undefined : existing.get(text);
      if (!match) {
        if (text === "") {
          inserts.push(item.values);
          insertLines.push(item.line);
        } else {
          pending.set(`new:${text}`, {
            ...pending.get(`new:${text}`),
            ...item.values,
          });
          lineOf.set(`new:${text}`, item.line);
        }
        continue;
      }
      if (match.locked) {
        failed += 1;
        if (errors.length < MAX_ERRORS) {
          errors.push({
            line: item.line,
            column: staged.headers[input.upsertSource ?? 0] ?? "",
            value: text.slice(0, 80),
            message: "Row locked",
            code: "row_locked",
          });
        }
        continue;
      }
      pending.set(match.id, { ...pending.get(match.id), ...item.values });
      lineOf.set(match.id, item.line);
    }
    for (const [id, values] of pending) {
      if (id.startsWith("new:")) {
        inserts.push(values);
        insertLines.push(lineOf.get(id) ?? 0);
      } else {
        updates.push({ rowId: id, values });
        updateLines.push(lineOf.get(id) ?? 0);
      }
    }
  } else {
    inserts.push(...valid.map((item) => item.values));
    insertLines.push(...valid.map((item) => item.line));
  }

  const total = inserts.length + updates.length;
  await input.onProgress?.(0, total);
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
  if (external) {
    const written = await importIntoClientTable(db, {
      context: {
        userId: input.userId,
        table,
        engine,
        catalog,
        reason,
        source: "import",
        depth: 0,
      },
      inserts: inserts.map((values, index) => ({
        values,
        line: insertLines[index] ?? 0,
      })),
      updates: updates.map((update, index) => ({
        ...update,
        line: updateLines[index] ?? 0,
      })),
      summary: (count) => batchContext(count).events as { summary: SummaryEvent },
      onProgress: input.onProgress,
      total,
      report: (error) => {
        failed += 1;
        if (errors.length < MAX_ERRORS) errors.push(error);
      },
    });
    return {
      tableId: table.id,
      inserted: written.inserted,
      updated: written.updated,
      failed,
      errors,
      createdColumns: createdNames.length,
    };
  }
  let inserted = 0;
  for (let index = 0; index < inserts.length; index += BATCH) {
    const batch = inserts.slice(index, index + BATCH);
    inserted += (
      await insertNativeBatch(db, engine, batchContext(inserted + batch.length), batch)
    ).length;
    await input.onProgress?.(inserted, total);
  }
  let updated = 0;
  for (let index = 0; index < updates.length; index += BATCH) {
    const batch = updates.slice(index, index + BATCH);
    updated += (
      await updateNativeBatch(
        db,
        engine,
        batchContext(inserted + updated + batch.length),
        batch,
      )
    ).length;
    await input.onProgress?.(inserted + updated, total);
  }
  return {
    tableId: table.id,
    inserted,
    updated,
    failed,
    errors,
    createdColumns: createdNames.length,
  };
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
const ROW_REFUSALS = /^(source_value_|source_write_refused|invalid_cell|row_locked|source_conflict|source_row_missing)/;

/**
 * Writes an import to a client's table (ADR 0028), batch by batch through
 * the compared, recorded write path. A batch the client refuses is written
 * again row by row, so the refused lines are named and the others kept;
 * a refusal that is not about a row (writes off, the source down) stops
 * the import.
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
    onProgress?: ((done: number, total: number) => Promise<void>) | undefined;
    total: number;
    report: (error: ImportError) => void;
  },
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
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
    const batch = input.inserts.slice(index, index + CLIENT_BATCH);
    try {
      inserted += (
        await insertExternalRows(
          db,
          context(inserted + updated + batch.length),
          batch.map((item) => item.values),
        )
      ).length;
    } catch (error) {
      if (!rowLevel(error)) throw error;
      for (const item of batch) {
        try {
          inserted += (
            await insertExternalRows(db, context(inserted + updated + 1), [
              item.values,
            ])
          ).length;
        } catch (cause) {
          if (!rowLevel(cause)) throw cause;
          refused(item.line, cause);
        }
      }
    }
    await input.onProgress?.(inserted + updated, input.total);
  }
  for (let index = 0; index < input.updates.length; index += CLIENT_BATCH) {
    const batch = input.updates.slice(index, index + CLIENT_BATCH);
    try {
      updated += (
        await updateExternalRows(
          db,
          context(inserted + updated + batch.length),
          batch.map(({ rowId, values }) => ({ rowId, values })),
        )
      ).length;
    } catch (error) {
      if (!rowLevel(error)) throw error;
      for (const item of batch) {
        try {
          updated += (
            await updateExternalRows(db, context(inserted + updated + 1), [
              { rowId: item.rowId, values: item.values },
            ])
          ).length;
        } catch (cause) {
          if (!rowLevel(cause)) throw cause;
          refused(item.line, cause);
        }
      }
    }
    await input.onProgress?.(inserted + updated, input.total);
  }
  return { inserted, updated };
}
