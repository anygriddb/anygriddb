import type { KeyRing } from "./auth/key-ring.js";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import {
  type Action,
  AppError,
  ATTACHMENT_KEY,
  ATTACHMENT_MAX_BYTES_CEILING,
  type Binding,
  columnNameSchema,
  effectiveTableRole,
  type ErrorCode,
  isImageAttachmentMime,
  isInlineAttachmentMime,
  resolveAttachmentMaxBytes,
  roleAllows,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { requestActor } from "./auth/access.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { type FileStore } from "./files/index.js";
import { localFolder } from "./files/local-folder.js";
import { sniffContentType } from "./storage.js";
import { readerEngine } from "./data/acl.js";
import { liveBase, liveTable } from "./data/live.js";
import { attachmentVisible } from "./data/rows.js";
import { publicErrorBody } from "./http.js";
import { readGateSettings } from "./settings.js";
import type { UploadSlots } from "./upload-slots.js";
import { acceptsFormFile, openShare } from "./data/open-share.js";
import { stagedDeadline } from "./data/staged-attachments.js";

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

/** What an attachment is stored from: bytes, or a local file and its size. */
export type AttachmentSource =
  { bytes: Buffer } | { path: string; size: number };

/** The first bytes, which say what a file is. */
async function headOf(source: AttachmentSource): Promise<Buffer> {
  if ("bytes" in source) return source.bytes;
  const handle = await open(source.path, "r");
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Stores a file and its metadata. Images also get a WebP thumbnail. The
 * MIME type comes from the bytes, never from the client. A local file is
 * streamed to the store, never held in memory whole.
 */
export async function storeAttachment(
  db: Database,
  files: FileStore,
  input: {
    tableId: string;
    userId: string;
    filename: string;
    /** A public form's link: the file waits for its answer (ADR 0062). */
    stagedShareId?: string;
  } & AttachmentSource,
): Promise<AttachmentMeta> {
  const mime = sniffContentType(
    await headOf(input),
    input.filename.toLowerCase().endsWith(".txt") ? "text/plain" : undefined,
  );
  const size = "bytes" in input ? input.bytes.length : input.size;
  const key = newKey();
  let width: number | null = null;
  let height: number | null = null;
  let thumbKey: string | null = null;
  if (isImageAttachmentMime(mime)) {
    try {
      const image = sharp("bytes" in input ? input.bytes : input.path, {
        limitInputPixels: 50_000_000,
      });
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
  if ("bytes" in input) await files.put(key, input.bytes, mime);
  else {
    await files.putFile(key, {
      body: createReadStream(input.path),
      size,
      contentType: mime,
    });
  }
  await db
    .insertInto("attachments")
    .values({
      key,
      tableId: input.tableId,
      filename: input.filename,
      mime,
      size,
      width,
      height,
      thumbKey,
      createdBy: input.userId,
      ...(input.stagedShareId
        ? { stagedShareId: input.stagedShareId, stagedUntil: stagedDeadline() }
        : {}),
    })
    .execute();
  return {
    key,
    filename: input.filename,
    mime,
    size,
    width,
    height,
    thumb: thumbKey !== null,
  };
}

export async function loadAttachmentMeta(
  db: Database,
  keys: readonly string[],
): Promise<
  Map<
    string,
    AttachmentMeta & {
      tableId: string;
      thumbKey: string | null;
      staged: boolean;
    }
  >
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
        staged: row.stagedShareId !== null,
      },
    ]),
  );
}

/**
 * Refuses keys that were not uploaded to this table. A file a public form's
 * link sent, until its answer claims it, belongs to that link alone (ADR
 * 0062): only that link's answer, `stagedBy`, may name it, and it may name
 * no other file.
 */
export async function assertAttachmentKeys(
  db: Database,
  tableId: string,
  keys: readonly string[],
  stagedBy?: string,
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
    .where((eb) =>
      stagedBy
        ? eb("stagedShareId", "=", stagedBy)
        : eb("stagedShareId", "is", null),
    )
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
  /** Opens a public form's link, for the files its answers carry. */
  encryptionKey: KeyRing;
  /** Environment bootstrap; the instance setting wins when set (ADR 0050). */
  envMaxBytes?: number;
  /** Uploads read at once, shared with imports and snapshots. */
  uploads: UploadSlots;
};
/**
 * Under field or row rules, a file is served only from a field the reader
 * may see, on a row they may see: the same check as `attachments.get`.
 */
export async function visibleToReader(
  deps: { db: Database },
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

function deny(reply: FastifyReply, status: number, code?: ErrorCode) {
  return reply.code(status).send(publicErrorBody(status, code));
}

/** Every upload slot is taken: try again in a moment. */
export function denyBusy(reply: FastifyReply) {
  return reply
    .header("Retry-After", "5")
    .code(503)
    .send(publicErrorBody(503, "uploads_busy"));
}

const uploadQuery = z.object({ tableId: z.uuid() });
const shareParams = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/),
});
const shareQuery = z.object({ field: columnNameSchema });
const shareAccess = z.string().max(200).optional();

/**
 * Reads one file to local disk under the limit in force, as it arrives,
 * then stores it for `owner` and answers with `answer(meta)`. Every slot
 * taken, a file past the limit, or a store that fails: answered here.
 */
async function receiveAttachment(
  deps: HttpDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  owner: { tableId: string; userId: string; stagedShareId?: string },
  answer: (meta: AttachmentMeta) => object,
) {
  const maxBytes = resolveAttachmentMaxBytes(
    await readGateSettings(deps.db),
    deps.envMaxBytes,
  );
  const release = deps.uploads.take();
  if (!release) return denyBusy(reply);
  const folder = await localFolder("upload");
  try {
    const file = await request.file({ limits: { fileSize: maxBytes } });
    if (!file) return await deny(reply, 400);
    const path = join(folder.path, "upload");
    try {
      await pipeline(
        file.file,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
    } catch (error) {
      request.log.warn({ err: error }, "attachment upload failed");
      return await deny(reply, 413);
    }
    const { size } = await stat(path);
    if (file.file.truncated || size === 0) return await deny(reply, 413);
    let meta: AttachmentMeta;
    try {
      meta = await storeAttachment(deps.db, deps.files, {
        ...owner,
        filename: cleanFilename(file.filename),
        path,
        size,
      });
    } catch (error) {
      request.log.error({ err: error }, "attachment upload failed");
      return await deny(reply, 500);
    }
    return await reply.send(answer(meta));
  } finally {
    await folder.remove();
    release();
  }
}

const keyParams = z.object({ key: z.string().regex(ATTACHMENT_KEY) });
const serveQuery = z.object({ download: z.enum(["1"]).optional() });

export async function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
): Promise<void> {
  // The most any instance may allow. Each upload is read under the limit
  // in force when it arrives (the setting, then the environment, then
  // 20 MiB), and written to local disk as it comes: a larger file is
  // refused as soon as it passes the limit, and none is held in memory.
  await app.register(multipart, {
    limits: { fileSize: ATTACHMENT_MAX_BYTES_CEILING, files: 1, fields: 4 },
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
    return receiveAttachment(
      deps,
      request,
      reply,
      { tableId: query.data.tableId, userId: actor.user.id },
      (meta) => meta,
    );
  });

  // A file for a public form's answer, sent before the answer (ADR 0062).
  // The link is its only credential: it must open a form, as its creator,
  // that shows this attachment field and lets them write it. The file
  // waits for that link's answer; nothing serves it until then, and the
  // answer only gets its name, size, and key back.
  app.post("/api/shares/:token/attachments", async (request, reply) => {
    const params = shareParams.safeParse(request.params);
    const query = shareQuery.safeParse(request.query);
    const access = shareAccess.safeParse(request.headers["x-share-access"]);
    if (!params.success || !query.success || !access.success)
      return deny(reply, 404);
    let opened: Awaited<ReturnType<typeof openShare>>;
    try {
      opened = await openShare(
        { db: deps.db, encryptionKey: deps.encryptionKey },
        { token: params.data.token, access: access.data },
        "write",
      );
    } catch (error) {
      if (error instanceof AppError) return deny(reply, 404);
      throw error;
    }
    if (!acceptsFormFile(opened, query.data.field)) return deny(reply, 404);
    return receiveAttachment(
      deps,
      request,
      reply,
      {
        tableId: opened.table.id,
        userId: opened.share.createdBy,
        stagedShareId: opened.share.id,
      },
      (meta) => ({ key: meta.key, filename: meta.filename, size: meta.size }),
    );
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
    // A file waiting for a form's answer is no row's yet: nobody reads it.
    if (!meta || meta.staged) return deny(reply, 404);
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
