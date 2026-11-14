/**
 * Uploads waiting for their job: the bytes in the file store, the owner
 * and the deadline in `staged_uploads`. Only the person who uploaded a
 * file can read it back.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Database } from "@anygriddb/db";
import { deleteFiles, type FileStore } from "../files/index.js";
import { newStagedKey } from "../storage.js";

type StagedKind = "import" | "snapshot" | "workbook";

/** Keeps a local file, streamed to the store: an archive too large to hold. */
export async function stageUploadFile(
  db: Database,
  files: FileStore,
  input: {
    userId: string;
    kind: StagedKind;
    filename: string;
    path: string;
    size: number;
    contentType: string;
    ttlSeconds: number;
    /** What reading the file found, for its job (ADR 0064). */
    meta?: Record<string, unknown>;
  },
): Promise<string> {
  const key = newStagedKey();
  await files.putFile(key, {
    body: createReadStream(input.path),
    size: input.size,
    contentType: input.contentType,
  });
  const row = await db
    .insertInto("stagedUploads")
    .values({
      userId: input.userId,
      kind: input.kind,
      filename: input.filename.slice(0, 255),
      fileKey: key,
      size: input.size,
      meta: input.meta ?? null,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Copies the upload to a local file, for its owner and while it is kept,
 * `maxBytes` at most; returns its name, or undefined.
 */
export async function copyStagedUpload(
  db: Database,
  files: FileStore,
  input: {
    id: string;
    userId: string;
    kind: StagedKind;
    maxBytes: number;
    path: string;
  },
): Promise<{ filename: string; size: number } | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(input.id)) return undefined;
  const row = await db
    .selectFrom("stagedUploads")
    .select(["fileKey", "filename"])
    .where("id", "=", input.id)
    .where("userId", "=", input.userId)
    .where("kind", "=", input.kind)
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  if (!row) return undefined;
  const file = await files.open(row.fileKey);
  if (!file) return undefined;
  if (file.size > input.maxBytes) {
    file.body.destroy();
    throw new Error("File too large");
  }
  await pipeline(
    file.body,
    createWriteStream(input.path, { flags: "wx", mode: 0o600 }),
  );
  return { filename: row.filename, size: file.size };
}

/** A queued job keeps its upload long enough to wait its turn. */
export async function keepStagedUpload(
  db: Database,
  id: string,
  ttlSeconds: number,
): Promise<void> {
  await db
    .updateTable("stagedUploads")
    .set({ expiresAt: new Date(Date.now() + ttlSeconds * 1000) })
    .where("id", "=", id)
    .execute();
}

export async function dropStagedUpload(
  db: Database,
  files: FileStore,
  id: string,
): Promise<void> {
  const row = await db
    .deleteFrom("stagedUploads")
    .where("id", "=", id)
    .returning("fileKey")
    .executeTakeFirst();
  if (row) await files.delete(row.fileKey);
}

/** Removes uploads past their deadline, rows and files. */
export async function purgeStagedUploads(
  db: Database,
  files: FileStore,
  onError: (error: unknown) => void,
): Promise<number> {
  const expired = await db
    .deleteFrom("stagedUploads")
    .where("expiresAt", "<", new Date())
    .returning("fileKey")
    .execute();
  await deleteFiles(
    files,
    expired.map((row) => row.fileKey),
    onError,
  );
  return expired.length;
}
