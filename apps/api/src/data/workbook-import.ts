/**
 * A workbook made a base (ADR 0078): an uploaded `.xlsx` file is staged
 * with what its first pass found in each worksheet; once its uploader
 * chooses the sheets, a job makes a new base whose tables are those
 * sheets, each written as it is read (ADR 0064), with the field types
 * every row of its sheet fits.
 */
import {
  AppError,
  CREATABLE_TYPES,
  type ImportCommitInput,
  type MadeNames,
  MAX_WORKBOOK_SHEETS,
  OPTION_COLORS,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { join } from "node:path";
import type { FileStore } from "../files/index.js";
import { localFolder } from "../files/local-folder.js";
import type { SheetShape, WorkbookSheet } from "../import-file.js";
import { readImportFileIsolated } from "../import-isolated.js";
import { findLiveTable } from "../services/rows.js";
import { loadEngine } from "./engine.js";
import {
  IMPORT_BATCH,
  importIntoTable,
  newTableColumns,
} from "./import-commit.js";
import { insertBase, insertTable } from "./schema-ops.js";
import {
  copyStagedUpload,
  dropStagedUpload,
  keepStagedUpload,
  stageUploadFile,
} from "./staged-uploads.js";

/** A workbook waits half an hour for its sheets to be chosen. */
const WORKBOOK_TTL_SECONDS = 30 * 60;
/** A queued one keeps its file two hours, enough to wait its turn. */
const WORKBOOK_JOB_TTL_SECONDS = 2 * 60 * 60;

const sheetSchema = z.object({
  sheet: z.int().min(0),
  name: z.string().min(1).max(100),
  hidden: z.boolean(),
  formulas: z.int().min(0),
  headers: z.array(z.string().min(1).max(100)).min(1).max(200),
  headerLine: z.int().min(0),
  total: z.int().min(0),
  fields: z
    .array(
      z.object({
        fieldType: z.enum(CREATABLE_TYPES),
        options: z
          .array(
            z.object({
              name: z.string().min(1).max(80),
              color: z.enum(OPTION_COLORS),
            }),
          )
          .max(200)
          .optional(),
      }),
    )
    .max(200),
});

const metaSchema = z.object({
  sheets: z.array(sheetSchema).min(1).max(MAX_WORKBOOK_SHEETS),
});

/** One worksheet of a staged workbook, as its first pass found it. */
export type StagedSheet = z.infer<typeof sheetSchema>;

type StagedWorkbook = {
  id: string;
  userId: string;
  filename: string;
  size: number;
  sheets: StagedSheet[];
};

/** Keeps an uploaded workbook, and what its first pass found, for its job. */
export async function stageWorkbook(
  db: Database,
  files: FileStore,
  input: {
    userId: string;
    filename: string;
    path: string;
    size: number;
    sheets: readonly WorkbookSheet[];
  },
): Promise<{ importId: string; sheets: StagedSheet[] }> {
  const meta = metaSchema.parse({
    sheets: input.sheets.map((sheet) => ({
      sheet: sheet.sheet,
      name: sheet.name,
      hidden: sheet.hidden,
      formulas: sheet.formulas,
      headers: sheet.shape.headers,
      headerLine: sheet.shape.headerLine,
      total: sheet.shape.total,
      fields: sheet.preview.inferred,
    })),
  });
  const importId = await stageUploadFile(db, files, {
    userId: input.userId,
    kind: "workbook",
    filename: input.filename,
    path: input.path,
    size: input.size,
    contentType: "application/octet-stream",
    ttlSeconds: WORKBOOK_TTL_SECONDS,
    meta,
  });
  return { importId, sheets: meta.sheets };
}

/** Only the person who uploaded the workbook reads it back, while it is kept. */
export async function loadStagedWorkbook(
  db: Database,
  id: string,
  userId: string,
): Promise<StagedWorkbook> {
  const row = /^[0-9a-f-]{36}$/.test(id)
    ? await db
        .selectFrom("stagedUploads")
        .select(["id", "userId", "filename", "size", "meta"])
        .where("id", "=", id)
        .where("userId", "=", userId)
        .where("kind", "=", "workbook")
        .where("expiresAt", ">", new Date())
        .executeTakeFirst()
    : undefined;
  const meta = metaSchema.safeParse(row?.meta);
  if (!row || !meta.success) throw new AppError("unknown_import");
  return {
    id: row.id,
    userId: row.userId,
    filename: row.filename,
    size: row.size,
    sheets: meta.data.sheets,
  };
}

export async function keepStagedWorkbook(
  db: Database,
  id: string,
): Promise<void> {
  await keepStagedUpload(db, id, WORKBOOK_JOB_TTL_SECONDS);
}

export async function dropStagedWorkbook(
  db: Database,
  files: FileStore,
  id: string,
): Promise<void> {
  await dropStagedUpload(db, files, id);
}

/** The name a workbook's base takes when its uploader gives none: its file's. */
export function workbookBaseName(filename: string): string {
  const name = filename
    .replace(/\.xlsx$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return name || filename.trim().slice(0, 100);
}

/** What came of one sheet: its rows written, and those refused. */
type SheetReport = {
  name: string;
  rows: number;
  failed: number;
  /** Its cells that held a formula: their values came. */
  formulas: number;
};

/**
 * Makes the base: a table for each chosen sheet, in the workbook's order,
 * its fields typed as the first pass guessed from all its rows, then its
 * rows written as they are read from the file at `path`.
 */
export async function importWorkbook(
  deps: {
    db: Database;
    files: FileStore;
    maxRows: number;
    names: MadeNames;
  },
  input: {
    userId: string;
    importId: string;
    name: string;
    sheets: readonly number[];
    eventKey: string;
    onCreated?: (baseId: string) => void;
    onProgress?: (done: number, total: number) => Promise<void>;
  },
): Promise<{ baseId: string; report: { sheets: SheetReport[] } }> {
  const { db, files } = deps;
  const staged = await loadStagedWorkbook(db, input.importId, input.userId);
  const asked = new Set(input.sheets);
  const chosen = staged.sheets.filter((sheet) => asked.has(sheet.sheet));
  if (chosen.length !== asked.size) throw new AppError("invalid_mapping");
  const total = chosen.reduce((sum, sheet) => sum + sheet.total, 0);
  if (total > deps.maxRows) throw new AppError("import_too_large");

  const base = await insertBase(db, input.userId, { name: input.name });
  input.onCreated?.(base.id);
  const report: SheetReport[] = [];
  let done = 0;
  const folder = await localFolder("import");
  try {
    const path = join(folder.path, "workbook");
    const copied = await copyStagedUpload(db, files, {
      id: staged.id,
      userId: staged.userId,
      kind: "workbook",
      maxBytes: staged.size,
      path,
    });
    if (!copied) throw new AppError("unknown_import");
    await input.onProgress?.(0, total);
    for (const sheet of chosen) {
      const mapping: ImportCommitInput["mapping"] = sheet.headers.map(
        (label, source) => ({
          source,
          create: {
            label,
            fieldType: sheet.fields[source]?.fieldType ?? "text",
          },
        }),
      );
      const options = new Map(
        sheet.fields.flatMap((field, source) =>
          field.options?.length ? [[source, field.options] as const] : [],
        ),
      );
      const made = await insertTable(db, input.userId, {
        baseId: base.id,
        name: sheet.name,
        columns: newTableColumns(mapping, options),
        viewName: deps.names.grid,
      });
      const table = await findLiveTable(db, made.id);
      if (!table) throw new AppError("unknown_table");
      const { rows } = await loadEngine(db, table.id, () => true);
      const created = rows.columns
        .filter((column) => column.tableId === table.id)
        .sort((a, b) => a.position - b.position)
        .map((column) => column.name);
      const shape: SheetShape = {
        format: "xlsx",
        headers: sheet.headers,
        headerLine: sheet.headerLine,
        total: sheet.total,
        sheet: sheet.sheet,
      };
      const before = done;
      const result = await importIntoTable(db, {
        userId: input.userId,
        table,
        source: {
          headers: sheet.headers,
          total: sheet.total,
          batches: () =>
            readImportFileIsolated(shape, path, IMPORT_BATCH, deps.maxRows),
        },
        mapping,
        addOptions: true,
        canManage: true,
        created,
        onProgress: async (read) => {
          await input.onProgress?.(before + read, total);
        },
        eventKey: `${input.eventKey}:${sheet.sheet}`,
      });
      done = before + sheet.total;
      report.push({
        name: sheet.name,
        rows: result.inserted,
        failed: result.failed,
        formulas: sheet.formulas,
      });
    }
    return { baseId: base.id, report: { sheets: report } };
  } finally {
    await folder.remove();
  }
}
