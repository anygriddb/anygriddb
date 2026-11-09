/**
 * Where files live (ADR 0010): attachments and their thumbnails, export
 * and snapshot files, and staged imports. One interface, two drivers:
 * a folder on disk (the default) and any S3-compatible service.
 */
import type { Readable } from "node:stream";
import { AppError } from "@anygriddb/core";

/**
 * Every key the application writes. Anything else is refused, so a key
 * can never name a path outside the store. A new kind of key needs its
 * reference check in `sweep.ts`; until then the orphan sweep keeps it.
 */
export const FILE_KEY =
  /^(?:att[A-Za-z0-9_-]{20,80}|(?:exports|staged)\/[0-9a-f-]{36})$/;

export function assertFileKey(key: string): void {
  if (!FILE_KEY.test(key)) throw new AppError("invalid_file");
}

export type StoredFile = {
  body: Readable;
  contentType: string;
  size: number;
};

export type FileEntry = {
  key: string;
  size: number;
  modifiedAt: Date;
};

export interface FileStore {
  /** `disk` or `s3`, for the health page and the migration command. */
  readonly driver: "disk" | "s3";
  /** Writes a file whole: a reader sees the old file or the new one. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /**
   * Writes a file from a stream of exactly `file.size` bytes, without
   * holding it in memory. A stream shorter or longer than that fails and
   * stores nothing.
   */
  putFile(key: string, file: StoredFile): Promise<void>;
  /** The file, or undefined when there is none under that key. */
  open(key: string): Promise<StoredFile | undefined>;
  /** Removes a file; a missing one is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Every file the application wrote, for migrations and the orphan
   * sweep. Anything else in the folder or the bucket is left out.
   */
  list(): AsyncIterable<FileEntry>;
  /**
   * Removes what writes interrupted before `before` left behind, and
   * returns how many. Disk: temporary files. S3: nothing, since a failed
   * upload stores no object.
   */
  tidy(before: Date): Promise<number>;
  /** Fails when the store cannot be written: checked at start and on the health page. */
  check(): Promise<void>;
}

/**
 * The bytes of `body`, failing unless there are exactly `size` of them.
 * A short stream fails before it ends, so an upload that announced its
 * length is aborted instead of left waiting for bytes that never come.
 */
export async function* exactBytes(
  body: Readable,
  size: number,
): AsyncGenerator<Buffer> {
  let seen = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    seen += buffer.length;
    if (seen > size) throw new Error("File size mismatch");
    yield buffer;
  }
  if (seen !== size) throw new Error("File size mismatch");
}

/** Reads a whole file, refusing one larger than `maxBytes`. */
export async function readFile(
  store: FileStore,
  key: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; contentType: string } | undefined> {
  const file = await store.open(key);
  if (!file) return undefined;
  if (file.size > maxBytes) {
    file.body.destroy();
    throw new Error("File too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of file.body) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBytes) {
      file.body.destroy();
      throw new Error("File too large");
    }
    chunks.push(buffer);
  }
  return { bytes: Buffer.concat(chunks), contentType: file.contentType };
}

/** Deletes files one by one; a failure is reported and the rest go on. */
export async function deleteFiles(
  store: FileStore,
  keys: readonly string[],
  onError: (error: unknown) => void,
): Promise<void> {
  for (const key of keys) {
    if (!FILE_KEY.test(key)) continue;
    try {
      await store.delete(key);
    } catch (error) {
      onError(error);
    }
  }
}
