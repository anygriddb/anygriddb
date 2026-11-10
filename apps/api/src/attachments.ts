import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import multipart from "@fastify/multipart";
import {
  type Action,
  AppError,
  ATTACHMENT_KEY,
  type Binding,
  effectiveTableRole,
  isImageAttachmentMime,
  isInlineAttachmentMime,
  roleAllows,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { requestActor } from "./auth/access.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { readFile, type FileStore } from "./files/index.js";
import { sniffContentType } from "./storage.js";
import { readerEngine } from "./data/acl.js";
import { liveBase, liveTable } from "./data/live.js";
import { attachmentVisible } from "./data/rows.js";
import { publicErrorBody } from "./http.js";

export const DEFAULT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const THUMB_EDGE = 320;

/**
 * PDFs are shown in an iframe in the attachment dialog. Default API
 * headers deny framing; same-origin framing is enough for that preview.
 */
export function attachmentFrameHeaders(
  mime: string,
  inline: boolean,
): { csp: string; frameOptions: string } | null {
  if (!inline || mime.toLowerCase() !== "application/pdf") return null;
  return {
    csp: "default-src 'none'; frame-ancestors 'self'; base-uri 'none'",
    frameOptions: "SAMEORIGIN",
  };
}

/** How a file is answered: inline preview, or a forced download. */
export function attachmentResponseMode(
  mime: string,
  options: { thumbnail?: boolean; forceDownload?: boolean },
): {
  mime: string;
  inline: boolean;
  contentType: string;
  frame: { csp: string; frameOptions: string } | null;
} {
  const outMime = options.thumbnail ? "image/webp" : mime;
  const knownInline =
    Boolean(options.thumbnail) || isInlineAttachmentMime(outMime);
  const inline = knownInline && !options.forceDownload;
  return {
    mime: outMime,
    inline,
    contentType: knownInline ? outMime : "application/octet-stream",
    frame: attachmentFrameHeaders(outMime, inline),
  };
}

export type AttachmentMeta = {
  key: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  thumb: boolean;
};

function newKey(): string {
  const key = `att${randomBytes(24).toString("base64url")}`;
  if (!ATTACHMENT_KEY.test(key)) {
    throw new AppError("invalid_attachment");
  }
  return key;
}

/** Keeps a printable, bounded file name; path separators and control characters go. */
export function cleanFilename(raw: string | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\p{Cc}"<>|*?:]/gu, "")
    .trim()
    .slice(0, 200);
  return cleaned || "fichier";
}

export function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Stores bytes and their metadata. Images also get a WebP thumbnail.
 * The MIME type comes from the bytes, never from the client.
 */
export async function storeAttachment(
  db: Database,
  files: FileStore,
  input: { tableId: string; userId: string; filename: string; bytes: Buffer },
): Promise<AttachmentMeta> {
  const mime = sniffContentType(
    input.bytes,
    input.filename.toLowerCase().endsWith(".txt") ? "text/plain" : undefined,
  );
  const key = newKey();
  let width: number | null = null;
  let height: number | null = null;
  let thumbKey: string | null = null;
  if (isImageAttachmentMime(mime)) {
    try {
      const image = sharp(input.bytes, { limitInputPixels: 50_000_000 });
      const meta = await image.metadata();
      width = meta.width;
      height = meta.height;
      const thumb = await image
        .rotate()
        .resize({
          width: THUMB_EDGE,
          height: THUMB_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 78 })
        .toBuffer();
      thumbKey = newKey();
      await files.put(thumbKey, thumb, "image/webp");
    } catch {
      thumbKey = null;
    }
  }
  await files.put(key, input.bytes, mime);
  await db
    .insertInto("attachments")
    .values({
      key,
      tableId: input.tableId,
      filename: input.filename,
      mime,
      size: input.bytes.length,
      width,
      height,
      thumbKey,
      createdBy: input.userId,
    })
    .execute();
  return {
    key,
    filename: input.filename,
    mime,
    size: input.bytes.length,
    width,
    height,
    thumb: thumbKey !== null,
  };
}

export async function loadAttachmentMeta(
  db: Database,
  keys: readonly string[],
): Promise<
  Map<string, AttachmentMeta & { tableId: string; thumbKey: string | null }>
> {
  const unique = [...new Set(keys)].filter((key) => ATTACHMENT_KEY.test(key));
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await db
    .selectFrom("attachments")
    .selectAll()
    .where("key", "in", unique)
    .execute();
  return new Map(
    rows.map((row) => [
      row.key,
      {
        key: row.key,
        tableId: row.tableId,
        filename: row.filename,
        mime: row.mime,
        // bigint in PostgreSQL; a file size stays far below 2^53.
        size: Number(row.size),
        width: row.width,
        height: row.height,
        thumb: row.thumbKey !== null,
        thumbKey: row.thumbKey,
      },
    ]),
  );
}

/** Refuses keys that were not uploaded to this table. */
export async function assertAttachmentKeys(
  db: Database,
  tableId: string,
  keys: readonly string[],
): Promise<void> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) {
    return;
  }
  const rows = await db
    .selectFrom("attachments")
    .select("key")
    .where("tableId", "=", tableId)
    .where("key", "in", unique)
    .execute();
  if (rows.length !== unique.length) {
    throw new AppError("invalid_attachment");
  }
}

/** Replaces attachment keys in rows with their metadata, for display. */
export async function enrichAttachments(
  db: Database,
  attachmentColumns: readonly string[],
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (attachmentColumns.length === 0 || rows.length === 0) {
    return;
  }
  const keys: string[] = [];
  for (const row of rows) {
    for (const column of attachmentColumns) {
      const value = row[column];
      if (Array.isArray(value)) {
        keys.push(
          ...value.filter((item): item is string => typeof item === "string"),
        );
      }
    }
  }
  const meta = await loadAttachmentMeta(db, keys);
  for (const row of rows) {
    for (const column of attachmentColumns) {
      const value = row[column];
      if (!Array.isArray(value)) continue;
      row[column] = (value as unknown[]).map((key) => {
        const found = typeof key === "string" ? meta.get(key) : undefined;
        return found
          ? {
              key: found.key,
              label: found.filename,
              filename: found.filename,
              mime: found.mime,
              size: found.size,
              width: found.width,
              height: found.height,
              thumb: found.thumb,
            }
          : {
              key,
              label: String(key),
              filename: String(key),
              mime: "application/octet-stream",
              size: 0,
              width: null,
              height: null,
              thumb: false,
            };
      });
    }
  }
}

type HttpDeps = {
  db: Database;
  files: FileStore;
  maxBytes: number;
};

/** A small attachment as base64, for the record panel's inline preview. */
export async function readAttachmentBase64(
  files: FileStore,
  key: string,
): Promise<{ contentType: string; contentBase64: string }> {
  if (!ATTACHMENT_KEY.test(key)) throw new AppError("invalid_attachment");
  const file = await readFile(files, key, 1_048_576).catch(() => undefined);
  if (!file || file.bytes.length < 1) throw new AppError("invalid_attachment");
  return {
    contentType: sniffContentType(file.bytes, file.contentType),
    contentBase64: file.bytes.toString("base64"),
  };
}

/**
 * Under field or row rules, a file is served only from a field the reader
 * may see, on a row they may see: the same check as `attachments.get`.
 */
export async function visibleToReader(
  deps: HttpDeps,
  reader: { userId: string; bindings: readonly Binding[] },
  tableId: string,
  key: string,
): Promise<boolean> {
  const { engine } = await readerEngine(deps.db, tableId, reader);
  if (!engine.access) return true;
  return attachmentVisible(deps.db, engine, key);
}

async function tableAccess(
  db: Database,
  bindings: readonly Binding[],
  tableId: string,
  action: Action,
): Promise<boolean> {
  const table = await db
    .selectFrom("dataTables as t")
    .innerJoin("bases as b", "b.id", "t.baseId")
    .select(["t.id", "t.baseId"])
    .where("t.id", "=", tableId)
    .where(liveTable("t"))
    .where(liveBase("b"))
    .executeTakeFirst();
  if (!table) return false;
  return roleAllows(
    effectiveTableRole(bindings, table.id, table.baseId),
    action,
  );
}

async function actorOf(db: Database, request: FastifyRequest) {
  try {
    return await requestActor(
      db,
      request.headers,
      request.cookies[SESSION_COOKIE],
    );
  } catch {
    return null;
  }
}

function deny(reply: FastifyReply, status: number) {
  return reply.code(status).send(publicErrorBody(status));
}

const uploadQuery = z.object({ tableId: z.uuid() });
const keyParams = z.object({ key: z.string().regex(ATTACHMENT_KEY) });
const serveQuery = z.object({ download: z.enum(["1"]).optional() });

export async function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  await app.register(multipart, {
    limits: { fileSize: deps.maxBytes, files: 1, fields: 4 },
  });

  app.post("/api/attachments", async (request, reply) => {
    const query = uploadQuery.safeParse(request.query);
    if (!query.success) return deny(reply, 400);
    const actor = await actorOf(deps.db, request);
    if (!actor) return deny(reply, 401);
    if (
      !(await tableAccess(deps.db, actor.bindings, query.data.tableId, "write"))
    )
      return deny(reply, 403);
    const user = actor.user;
    const file = await request.file();
    if (!file) return deny(reply, 400);
    let bytes: Buffer;
    try {
      bytes = await file.toBuffer();
    } catch {
      return deny(reply, 413);
    }
    if (file.file.truncated || bytes.length === 0) return deny(reply, 413);
    let meta: Awaited<ReturnType<typeof storeAttachment>>;
    try {
      meta = await storeAttachment(deps.db, deps.files, {
        tableId: query.data.tableId,
        userId: user.id,
        filename: cleanFilename(file.filename),
        bytes,
      });
    } catch (error) {
      request.log.error({ err: error }, "attachment upload failed");
      return deny(reply, 500);
    }
    return reply.send(meta);
  });

  async function serve(
    request: FastifyRequest,
    reply: FastifyReply,
    thumbnail: boolean,
  ) {
    const params = keyParams.safeParse(request.params);
    if (!params.success) return deny(reply, 404);
    const actor = await actorOf(deps.db, request);
    if (!actor) return deny(reply, 401);
    const meta = (await loadAttachmentMeta(deps.db, [params.data.key])).get(
      params.data.key,
    );
    if (!meta) return deny(reply, 404);
    if (!(await tableAccess(deps.db, actor.bindings, meta.tableId, "read")))
      return deny(reply, 404);
    if (
      !(await visibleToReader(
        deps,
        { userId: actor.user.id, bindings: actor.bindings },
        meta.tableId,
        meta.key,
      ))
    )
      return deny(reply, 404);
    const objectKey = thumbnail ? meta.thumbKey : meta.key;
    if (!objectKey) return deny(reply, 404);
    let body: Readable;
    try {
      const file = await deps.files.open(objectKey);
      if (!file) return await deny(reply, 404);
      body = file.body;
      reply.header("Content-Length", file.size);
    } catch (error) {
      request.log.error({ err: error }, "attachment download failed");
      return deny(reply, 404);
    }
    const query = serveQuery.safeParse(request.query);
    const forceDownload =
      !thumbnail && query.success && query.data.download === "1";
    const mode = attachmentResponseMode(meta.mime, {
      thumbnail,
      forceDownload,
    });
    reply.header("Content-Type", mode.contentType);
    reply.header(
      "Content-Disposition",
      contentDisposition(meta.filename, mode.inline),
    );
    reply.header("Cache-Control", "private, max-age=3600");
    reply.header("Cross-Origin-Resource-Policy", "same-site");
    if (mode.frame) {
      reply.header("Content-Security-Policy", mode.frame.csp);
      reply.header("X-Frame-Options", mode.frame.frameOptions);
    }
    return reply.send(body);
  }

  app.get("/api/attachments/:key", (request, reply) =>
    serve(request, reply, false),
  );
  app.get("/api/attachments/:key/thumb", (request, reply) =>
    serve(request, reply, true),
  );
}
