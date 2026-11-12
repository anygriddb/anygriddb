import { once } from "node:events";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type Action,
  andFilters,
  AppError,
  type Binding,
  cellText,
  effectiveTableRole,
  type EngineCatalog,
  type EngineColumn,
  type ErrorCode,
  EXPORT_FORMATS,
  type ExportFormat,
  type ExportJobInput,
  exportJobInputSchema,
  MAX_SNAPSHOT_ARCHIVE_BYTES,
  normalizeViewConfig,
  pruneViewConfig,
  type ReadSpec,
  roleAllows,
  roleFor,
  toCsv,
  toCsvRows,
  viewFilter,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import ExcelJS from "exceljs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Bus } from "./realtime/bus.js";
import { z } from "zod";
import {
  cleanFilename,
  contentDisposition,
  denyBusy,
  enrichAttachments,
} from "./attachments.js";
import type { UploadSlots } from "./upload-slots.js";
import { requestActor } from "./auth/access.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { MAX_COPY_ROWS, readAll } from "./data/data-ops.js";
import type { TableRow } from "./data/engine.js";
import { stageImport } from "./data/import-commit.js";
import {
  listCollaborators,
  readPage,
  safeTimeZone,
  type RowRecord,
} from "./data/rows.js";
import { loadView } from "./data/views.js";
import {
  detectImportFormat,
  IMPORT_LIMITS,
  previewSheet,
} from "./import-file.js";
import { parseImportFileIsolated } from "./import-isolated.js";
import { findLiveTable } from "./services/rows.js";
import { snapshotFolder, stageSnapshotFile } from "./data/snapshot-stage.js";
import { localFolder } from "./files/local-folder.js";
import { loadOwnJob } from "./jobs.js";
import { readerEngine } from "./data/acl.js";
import type { FileStore } from "./files/index.js";
import { publicErrorBody } from "./http.js";

type Deps = {
  db: Database;
  bus: Bus;
  files: FileStore;
  /** Uploads read at once, shared with attachments. */
  uploads: UploadSlots;
};

type Actor = NonNullable<Awaited<ReturnType<typeof requestActor>>>;

const PEOPLE_TYPES = new Set(["user", "created_by", "last_modified_by"]);
const DATE_TYPES = new Set(["date"]);
const DATETIME_TYPES = new Set([
  "datetime",
  "created_time",
  "last_modified_time",
]);
const EXCEL_CELL = 32_767;

const MIME: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function actorOf(
  db: Database,
  request: FastifyRequest,
): Promise<Actor | null> {
  try {
    return await requestActor(
      db,
      request.headers,
      request.cookies[SESSION_COOKIE],
    );
  } catch (error) {
    request.log.warn({ err: error }, "actor rejected");
    return null;
  }
}

function deny(reply: FastifyReply, status: number, code?: ErrorCode) {
  return reply.code(status).send(publicErrorBody(status, code));
}

function allowed(
  bindings: readonly Binding[],
  table: { id: string; baseId: string },
  action: Action,
): boolean {
  return roleAllows(
    effectiveTableRole(bindings, table.id, table.baseId),
    action,
  );
}

async function loadTable(
  db: Database,
  tableId: string,
): Promise<TableRow | null> {
  return (await findLiveTable(db, tableId)) ?? null;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** Visible columns of a view, in its order; every column without a view. */
export function exportColumns(
  engine: EngineCatalog,
  config: { fieldOrder?: string[]; hiddenFields?: string[] } | null,
): EngineColumn[] {
  const all = engine.table.columns;
  if (!config) return [...all];
  const order = config.fieldOrder ?? [];
  const hidden = new Set(config.hiddenFields ?? []);
  const ranked = [
    ...order.flatMap((name) => all.filter((column) => column.name === name)),
    ...all.filter((column) => !order.includes(column.name)),
  ];
  return ranked.filter((column) => !hidden.has(column.name));
}

/**
 * A cell as exported: people by name, links and attachments by label,
 * other arrays as lists. JSON keeps lists; CSV and XLSX join them.
 */
export function exportValue(
  column: EngineColumn,
  value: unknown,
  people: ReadonlyMap<string, string>,
): string | number | boolean | string[] | null {
  if (value === null || value === undefined) return null;
  if (PEOPLE_TYPES.has(column.fieldType)) {
    const ids = Array.isArray(value) ? value : [value];
    return ids.map((id) => people.get(String(id)) ?? String(id));
  }
  if (Array.isArray(value)) {
    return value.map((item) => cellText([item]));
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return cellText(value);
}

function excelValue(
  column: EngineColumn,
  value: ReturnType<typeof exportValue>,
): string | number | boolean | Date | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value.join(", ").slice(0, EXCEL_CELL);
  if (typeof value === "string") {
    if (DATE_TYPES.has(column.fieldType) && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Date(`${value}T00:00:00Z`);
    }
    if (DATETIME_TYPES.has(column.fieldType)) {
      const time = Date.parse(value);
      if (Number.isFinite(time)) return new Date(time);
    }
    return value.slice(0, EXCEL_CELL);
  }
  return value;
}

/** Worksheet names allow 31 characters and none of `[]:*?/\`. */
export function sheetName(name: string): string {
  return (
    name
      .replace(/[[\]:*?/\\]/g, " ")
      .trim()
      .slice(0, 31) || "Export"
  );
}

/** What writes an export to its file, one page of rows after another. */
export type ExportWriter = {
  /** Writes the next rows, in order. */
  add(rows: readonly RowRecord[]): Promise<void>;
  /** Ends the file and says its size in bytes. */
  finish(): Promise<number>;
  /** Stops writing after a failure; the caller removes the file. */
  abandon(): void;
};

async function writeText(stream: WriteStream, text: string): Promise<void> {
  if (!stream.write(text)) await once(stream, "drain");
}

/**
 * Writes an export to `path` as its rows come: CSV and JSON as text, an
 * XLSX workbook through the writer that streams. No page is kept once
 * written.
 */
export function exportWriter(
  format: ExportFormat,
  path: string,
  tableName: string,
  columns: readonly EngineColumn[],
  people: ReadonlyMap<string, string>,
): ExportWriter {
  const valuesOf = (row: RowRecord) =>
    columns.map((column) => exportValue(column, row[column.name], people));
  if (format === "xlsx") {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path,
      useStyles: true,
      useSharedStrings: false,
    });
    workbook.creator = "AnyGridDB";
    const sheet = workbook.addWorksheet(sheetName(tableName), {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.columns = columns.map((column) => ({
      header: column.label,
      key: column.name,
      width: Math.min(60, Math.max(10, column.label.length + 2)),
      style: DATE_TYPES.has(column.fieldType)
        ? { numFmt: "yyyy-mm-dd" }
        : DATETIME_TYPES.has(column.fieldType)
          ? { numFmt: "yyyy-mm-dd hh:mm" }
          : {},
    }));
    sheet.getRow(1).font = { bold: true };
    return {
      add(rows) {
        for (const row of rows) {
          const cells = valuesOf(row);
          sheet
            .addRow(
              columns.map((column, at) =>
                excelValue(column, cells[at] ?? null),
              ),
            )
            .commit();
        }
        return Promise.resolve();
      },
      async finish() {
        sheet.commit();
        await workbook.commit();
        return (await stat(path)).size;
      },
      abandon() {
        // The workbook writes to its own stream; removing the folder ends it.
      },
    };
  }
  const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const headers = columns.map((column) => column.label);
  let written = 0;
  // The byte order mark lets spreadsheet programs read UTF-8.
  let opening: Promise<void> | undefined = writeText(
    stream,
    format === "csv" ? `\uFEFF${toCsv(headers, [])}` : "[",
  );
  return {
    async add(rows) {
      await opening;
      opening = undefined;
      if (rows.length === 0) return;
      const values = rows.map(valuesOf);
      if (format === "csv") {
        await writeText(
          stream,
          `\n${toCsvRows(
            headers,
            values.map((cells) =>
              Object.fromEntries(
                headers.map((header, at) => [header, cells[at] ?? null]),
              ),
            ),
          )}`,
        );
      } else {
        const records = values.map((cells, index) => ({
          id: rows[index]?.id,
          ...Object.fromEntries(
            columns.map((column, at) => [column.label, cells[at] ?? null]),
          ),
        }));
        // As `JSON.stringify(all, null, 2)` would lay it out, one record
        // after another.
        await writeText(
          stream,
          records
            .map(
              (record, index) =>
                `${written + index === 0 ? "\n" : ",\n"}${JSON.stringify(
                  record,
                  null,
                  2,
                ).replace(/^/gm, "  ")}`,
            )
            .join(""),
        );
      }
      written += rows.length;
    },
    async finish() {
      await opening;
      if (format === "json")
        await writeText(stream, written === 0 ? "]" : "\n]");
      stream.end();
      await once(stream, "close");
      return (await stat(path)).size;
    },
    abandon() {
      stream.destroy();
    },
  };
}

const exportParams = z.object({ tableId: z.uuid() });
const jobFileParams = z.object({ jobId: z.uuid() });

/** What an export job records about its file. */
export const exportResultSchema = z.object({
  rows: z.int().min(0),
  format: z.enum(EXPORT_FORMATS),
  filename: z.string().min(1).max(255),
  size: z.int().min(0),
});

/** Table export or base snapshot file metadata on a finished job. */
const jobFileResultSchema = z.object({
  rows: z.int().min(0).nullable().optional(),
  format: z.enum([...EXPORT_FORMATS, "json", "zip"] as const),
  filename: z.string().min(1).max(255),
  size: z.int().min(0),
});
const exportQuery = exportJobInputSchema.omit({ tableId: true });

export const EXPORT_MIME = MIME;

/**
 * Writes a table, or one of its views, with the reader's rights, to a
 * local file, page by page as the rows are read. Shared by the direct
 * download and the export job, which reports its progress. A view with
 * more rows than `maxRows` is refused before anything is written.
 */
export async function exportTable(
  deps: { db: Database },
  actor: { userId: string; bindings: readonly Binding[] },
  table: TableRow,
  query: Omit<ExportJobInput, "tableId">,
  options: {
    path: string;
    maxRows: number;
    onProgress?: (done: number, total: number | null) => Promise<void>;
  },
): Promise<{ rows: number; size: number }> {
  const { engine } = await readerEngine(deps.db, table.id, actor);
  let spec: Omit<ReadSpec, "limit"> = {
    search: query.search,
    timeZone: safeTimeZone(query.timeZone),
    me: actor.userId,
  };
  let config: ReturnType<typeof normalizeViewConfig> | null = null;
  if (query.viewId) {
    const view = await loadView(deps.db, query.viewId);
    if (
      view.tableId !== table.id ||
      (view.ownerId && view.ownerId !== actor.userId)
    ) {
      throw new AppError("invalid_view");
    }
    config = pruneViewConfig(
      normalizeViewConfig(view.config, view.viewType),
      new Set(engine.table.columns.map((column) => column.name)),
    );
    spec = {
      ...spec,
      filter: andFilters(viewFilter(config)),
      sort: config.sort,
      search: query.search ?? config.search,
    };
  }
  const columns = exportColumns(engine, config).filter(
    (column) => !engine.access?.hidden(engine.table.id, column.name),
  );
  const counted = await readPage(
    deps.db,
    engine,
    { ...spec, limit: 1, fields: [] },
    { total: true },
  );
  const total = counted.total ?? 0;
  if (total > options.maxRows) throw new AppError("export_too_large");
  await options.onProgress?.(0, total);
  const people = new Map(
    (await listCollaborators(deps.db, table.baseId)).map((person) => [
      person.id,
      person.displayName,
    ]),
  );
  const files = columns
    .filter((column) => column.fieldType === "attachment")
    .map((column) => column.name);
  const writer = exportWriter(
    query.format,
    options.path,
    table.name,
    columns,
    people,
  );
  let rows = 0;
  try {
    await readAll(
      deps.db,
      engine,
      columns.map((column) => column.name),
      async (page) => {
        await enrichAttachments(deps.db, files, page);
        await writer.add(page);
        rows += page.length;
        await options.onProgress?.(rows, total);
      },
      spec,
      options.maxRows,
    );
    return { rows, size: await writer.finish() };
  } catch (error) {
    writer.abandon();
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const previewQuery = z.union([
  z.object({ tableId: z.uuid() }).strict(),
  z.object({ baseId: z.uuid() }).strict(),
]);

export function registerDataTransferRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  /**
   * Parses an uploaded file and keeps it for `rows.importCommit`. Adding
   * rows needs write access to the table; a new table needs manage access
   * to the base.
   */
  app.post("/api/import/preview", async (request, reply) => {
    const query = previewQuery.safeParse(request.query);
    if (!query.success) return deny(reply, 400);
    const actor = await actorOf(deps.db, request);
    if (!actor) return deny(reply, 401);
    if ("tableId" in query.data) {
      const table = await loadTable(deps.db, query.data.tableId);
      if (!table || !allowed(actor.bindings, table, "write"))
        return deny(reply, 403);
    } else {
      const baseId = query.data.baseId;
      if (!roleAllows(roleFor(actor.bindings, "base", baseId), "manage")) {
        return deny(reply, 403);
      }
    }
    const release = deps.uploads.take();
    if (!release) return denyBusy(reply);
    let bytes: Buffer;
    let file: NonNullable<Awaited<ReturnType<typeof request.file>>>;
    try {
      const upload = await request.file({
        limits: { fileSize: IMPORT_LIMITS.maxBytes, files: 1, fields: 2 },
      });
      if (!upload) return await deny(reply, 400);
      file = upload;
      bytes = await file.toBuffer();
    } catch (error) {
      request.log.warn({ err: error }, "import upload too large");
      return await deny(reply, 413);
    } finally {
      release();
    }
    if (file.file.truncated || bytes.length === 0) return deny(reply, 413);
    const filename = cleanFilename(file.filename);
    let preview: Record<string, unknown>;
    try {
      const format = detectImportFormat(filename);
      const sheet = await parseImportFileIsolated(format, bytes);
      const importId = await stageImport(
        deps.db,
        deps.files,
        actor.user.id,
        filename,
        sheet,
      );
      preview = { importId, filename, format, ...previewSheet(sheet) };
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === "invalid_import" || error.code === "too_many_rows")
      ) {
        return deny(reply, 400, error.code);
      }
      request.log.error({ err: error }, "import preview failed");
      return deny(reply, 500);
    }
    return reply.send(preview);
  });

  /**
   * A table or one of its views as CSV, JSON, or XLSX, up to 100,000 rows:
   * written to a local file as it is read, then sent from it. A larger
   * view goes through an export job.
   */
  app.get("/api/export/:tableId", async (request, reply) => {
    const params = exportParams.safeParse(request.params);
    const query = exportQuery.safeParse(request.query);
    if (!params.success || !query.success) return deny(reply, 400);
    const actor = await actorOf(deps.db, request);
    if (!actor) return deny(reply, 401);
    const table = await loadTable(deps.db, params.data.tableId);
    if (!table || !allowed(actor.bindings, table, "read"))
      return deny(reply, 404);
    const folder = await localFolder("export");
    const path = join(folder.path, "export");
    let size: number;
    try {
      const exported = await exportTable(
        deps,
        { userId: actor.user.id, bindings: actor.bindings },
        table,
        query.data,
        { path, maxRows: MAX_COPY_ROWS },
      );
      size = exported.size;
      request.log.info(
        {
          tableId: table.id,
          format: query.data.format,
          rows: exported.rows,
          max: MAX_COPY_ROWS,
        },
        "table exported",
      );
    } catch (error) {
      await folder.remove();
      if (
        error instanceof AppError &&
        (error.code === "invalid_view" || error.code === "export_too_large")
      ) {
        return deny(reply, 400, error.code);
      }
      request.log.error({ err: error }, "export failed");
      return deny(reply, 500);
    }
    // The folder goes once the answer has left, or was cut short.
    reply.raw.once("close", () => {
      void folder.remove();
    });
    return reply
      .header("Content-Type", MIME[query.data.format])
      .header("Content-Length", size)
      .header(
        "Content-Disposition",
        contentDisposition(
          `${cleanFilename(table.name)}.${query.data.format}`,
          false,
        ),
      )
      .header("Cache-Control", "no-store")
      .send(createReadStream(path));
  });

  /** The file of a finished export or snapshot job, for its author, 24 hours. */
  app.get("/api/jobs/:jobId/file", async (request, reply) => {
    const params = jobFileParams.safeParse(request.params);
    if (!params.success) return deny(reply, 400);
    const actor = await actorOf(deps.db, request);
    if (!actor) return deny(reply, 401);
    let job: Awaited<ReturnType<typeof loadOwnJob>>;
    try {
      job = await loadOwnJob(deps.db, actor.user.id, params.data.jobId);
    } catch (error) {
      request.log.warn({ err: error }, "job file denied");
      return deny(reply, 404);
    }
    const result = jobFileResultSchema.safeParse(job.result);
    if (
      (job.kind !== "export" && job.kind !== "export_snapshot") ||
      job.status !== "done" ||
      !job.fileKey ||
      !job.fileExpiresAt ||
      job.fileExpiresAt.getTime() <= Date.now() ||
      !result.success
    ) {
      return deny(reply, 404);
    }
    const type =
      result.data.format === "json"
        ? "application/json; charset=utf-8"
        : result.data.format === "zip"
          ? "application/zip"
          : MIME[result.data.format];
    let file: { body: Readable; size: number } | undefined;
    try {
      file = await deps.files.open(job.fileKey);
    } catch (error) {
      request.log.error({ err: error }, "job file read failed");
      return deny(reply, 500);
    }
    if (!file) return deny(reply, 404);
    reply
      .header("Content-Type", type)
      .header(
        "Content-Disposition",
        contentDisposition(result.data.filename, false),
      )
      .header("Cache-Control", "no-store");
    reply.header("Content-Length", file.size);
    return reply.send(file.body);
  });

  /**
   * Stages a base snapshot for `catalog.importSnapshot`: a JSON file, or
   * an archive with its files, written to a local file as it arrives.
   */
  app.post("/api/snapshot/upload", async (request, reply) => {
    const actor = await actorOf(deps.db, request);
    if (!actor) return deny(reply, 401);
    const release = deps.uploads.take();
    if (!release) return denyBusy(reply);
    const folder = await snapshotFolder();
    try {
      const upload = await request.file({
        limits: { fileSize: MAX_SNAPSHOT_ARCHIVE_BYTES, files: 1, fields: 2 },
      });
      if (!upload) return await deny(reply, 400, "invalid_snapshot");
      const path = join(folder.path, "upload");
      try {
        await pipeline(
          upload.file,
          createWriteStream(path, { flags: "wx", mode: 0o600 }),
        );
      } catch (error) {
        request.log.warn({ err: error }, "snapshot upload failed");
        return await deny(reply, 413, "too_large_snapshot");
      }
      const { size } = await stat(path);
      if (upload.file.truncated)
        return await deny(reply, 413, "too_large_snapshot");
      if (size === 0) return await deny(reply, 400, "invalid_snapshot");
      let staged: Awaited<ReturnType<typeof stageSnapshotFile>>;
      try {
        staged = await stageSnapshotFile(deps.db, deps.files, {
          userId: actor.user.id,
          path,
          size,
          filename: cleanFilename(upload.filename || "base.anygriddb.json"),
        });
      } catch (error) {
        if (error instanceof AppError && error.code === "too_large_snapshot") {
          return await deny(reply, 413, "too_large_snapshot");
        }
        if (
          (error instanceof AppError && error.code === "invalid_snapshot") ||
          (error instanceof Error && error.name === "ZodError")
        ) {
          return await deny(reply, 400, "invalid_snapshot");
        }
        request.log.error({ err: error }, "snapshot upload failed");
        return await deny(reply, 500);
      }
      return await reply.send({
        snapshotId: staged.snapshotId,
        name: staged.snapshot.base.name,
        tables: staged.snapshot.tables.length,
        rows: staged.snapshot.tables.reduce(
          (sum, table) => sum + (table.rows?.length ?? 0),
          0,
        ),
        files: staged.snapshot.files?.length ?? 0,
        members: staged.snapshot.members?.length ?? 0,
      });
    } finally {
      await folder.remove();
      release();
    }
  });
}
