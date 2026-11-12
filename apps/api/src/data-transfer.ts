import { createWriteStream } from "node:fs";
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

export async function renderExport(
  format: ExportFormat,
  tableName: string,
  columns: readonly EngineColumn[],
  rows: readonly RowRecord[],
  people: ReadonlyMap<string, string>,
): Promise<Buffer> {
  const values = rows.map((row) =>
    columns.map((column) => exportValue(column, row[column.name], people)),
  );
  if (format === "json") {
    const records = values.map((cells, index) => ({
      id: rows[index]?.id,
      ...Object.fromEntries(
        columns.map((column, at) => [column.label, cells[at] ?? null]),
      ),
    }));
    return Buffer.from(JSON.stringify(records, null, 2));
  }
  if (format === "csv") {
    const headers = columns.map((column) => column.label);
    const csv = toCsv(
      headers,
      values.map((cells) =>
        Object.fromEntries(
          headers.map((header, at) => [header, cells[at] ?? null]),
        ),
      ),
    );
    // The byte order mark lets spreadsheet programs read UTF-8.
    return Buffer.from(`\uFEFF${csv}`);
  }
  const workbook = new ExcelJS.Workbook();
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
  for (const cells of values) {
    sheet.addRow(
      columns.map((column, at) => excelValue(column, cells[at] ?? null)),
    );
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
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
 * Renders a table, or one of its views, with the reader's rights. Shared
 * by the direct download and the export job, which reports its progress.
 */
export async function exportTable(
  deps: { db: Database },
  actor: { userId: string; bindings: readonly Binding[] },
  table: TableRow,
  query: Omit<ExportJobInput, "tableId">,
  onProgress?: (done: number, total: number | null) => Promise<void>,
): Promise<{ body: Buffer; rows: number }> {
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
  const collected: RowRecord[] = [];
  let total: number | null = null;
  if (onProgress) {
    const counted = await readPage(
      deps.db,
      engine,
      { ...spec, limit: 1, fields: [] },
      { total: true },
    );
    total = Math.min(counted.total ?? 0, MAX_COPY_ROWS);
    await onProgress(0, total);
  }
  await readAll(
    deps.db,
    engine,
    columns.map((column) => column.name),
    async (page) => {
      collected.push(...page);
      await onProgress?.(collected.length, total);
    },
    spec,
  );
  await enrichAttachments(
    deps.db,
    columns
      .filter((column) => column.fieldType === "attachment")
      .map((column) => column.name),
    collected,
  );
  const people = new Map(
    (await listCollaborators(deps.db, table.baseId)).map((person) => [
      person.id,
      person.displayName,
    ]),
  );
  return {
    body: await renderExport(
      query.format,
      table.name,
      columns,
      collected,
      people,
    ),
    rows: collected.length,
  };
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

  /** A table or one of its views as CSV, JSON, or XLSX, up to 100,000 rows. */
  app.get("/api/export/:tableId", async (request, reply) => {
    const params = exportParams.safeParse(request.params);
    const query = exportQuery.safeParse(request.query);
    if (!params.success || !query.success) return deny(reply, 400);
    const actor = await actorOf(deps.db, request);
    if (!actor) return deny(reply, 401);
    const table = await loadTable(deps.db, params.data.tableId);
    if (!table || !allowed(actor.bindings, table, "read"))
      return deny(reply, 404);
    let exported: Buffer;
    try {
      const { body, rows } = await exportTable(
        deps,
        { userId: actor.user.id, bindings: actor.bindings },
        table,
        query.data,
      );
      exported = body;
      request.log.info(
        {
          tableId: table.id,
          format: query.data.format,
          rows,
          max: MAX_COPY_ROWS,
        },
        "table exported",
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "invalid_view") {
        return deny(reply, 400, error.code);
      }
      request.log.error({ err: error }, "export failed");
      return deny(reply, 500);
    }
    return reply
      .header("Content-Type", MIME[query.data.format])
      .header(
        "Content-Disposition",
        contentDisposition(
          `${cleanFilename(table.name)}.${query.data.format}`,
          false,
        ),
      )
      .header("Cache-Control", "no-store")
      .send(exported);
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
