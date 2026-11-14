/**
 * Uploaded snapshots, until their import job runs: a JSON file, or a ZIP
 * archive that also holds the attachments' files (ADR 0039). Both are
 * checked at upload, so a broken file is refused then, not in the job.
 */
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  type BaseSnapshot,
  MAX_SNAPSHOT_ARCHIVE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
  SNAPSHOT_ENTRY,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FileStore } from "../files/index.js";
import { localFolder } from "../files/local-folder.js";
import { parseSnapshotBytes } from "./base-snapshot.js";
import {
  copyStagedUpload,
  dropStagedUpload,
  keepStagedUpload,
  stageUploadFile,
} from "./staged-uploads.js";
import { isZip, ZipError, ZipReader } from "./zip.js";

const STAGE_TTL = 30 * 60;
/** Kept two hours once the import job is queued. */
const QUEUED_TTL = 2 * 60 * 60;

async function head(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, 4, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Reads a snapshot from a local file: JSON, or an archive whose every
 * listed file is there, at its size.
 */
async function readSnapshotFile(
  path: string,
  size: number,
): Promise<{ snapshot: BaseSnapshot; archive?: ZipReader }> {
  if (!isZip(await head(path))) {
    if (size > MAX_SNAPSHOT_BYTES) throw new AppError("too_large_snapshot");
    return { snapshot: parseSnapshotBytes(await readFile(path)) };
  }
  if (size > MAX_SNAPSHOT_ARCHIVE_BYTES) {
    throw new AppError("too_large_snapshot");
  }
  try {
    const archive = await ZipReader.open(path, {
      maxEntries: MAX_SNAPSHOT_FILES + 1,
    });
    const bytes = await archive.read(SNAPSHOT_ENTRY, MAX_SNAPSHOT_BYTES);
    if (!bytes) throw new AppError("invalid_snapshot");
    const snapshot = parseSnapshotBytes(bytes);
    for (const file of snapshot.files ?? []) {
      if (archive.entries.get(`files/${file.id}`)?.size !== file.size) {
        throw new AppError("invalid_snapshot");
      }
    }
    return { snapshot, archive };
  } catch (error) {
    if (error instanceof ZipError) {
      throw new AppError("invalid_snapshot", { cause: error });
    }
    throw error;
  }
}

/** Keeps an uploaded snapshot, read from a local file, until its job claims it. */
export async function stageSnapshotFile(
  db: Database,
  files: FileStore,
  input: { userId: string; path: string; size: number; filename: string },
): Promise<{ snapshotId: string; snapshot: BaseSnapshot }> {
  const { snapshot, archive } = await readSnapshotFile(input.path, input.size);
  const snapshotId = await stageUploadFile(db, files, {
    userId: input.userId,
    kind: "snapshot",
    filename: input.filename,
    path: input.path,
    size: input.size,
    contentType: archive ? "application/zip" : "application/json",
    ttlSeconds: STAGE_TTL,
  });
  return { snapshotId, snapshot };
}

type OpenedSnapshot = {
  snapshot: BaseSnapshot;
  filename: string;
  /**
   * A file of the archive by its id, `maxBytes` at most, checked against
   * its SHA-256; undefined when the snapshot does not hold it.
   */
  readFile: (id: string, maxBytes: number) => Promise<Buffer | undefined>;
  /** Removes the local copy. */
  close: () => Promise<void>;
};

/** The staged snapshot, copied to a local file for its import. */
export async function openStagedSnapshot(
  db: Database,
  files: FileStore,
  id: string,
  userId: string,
): Promise<OpenedSnapshot> {
  const folder = await localFolder("snapshot");
  try {
    const path = join(folder.path, "upload");
    const copied = await copyStagedUpload(db, files, {
      id,
      userId,
      kind: "snapshot",
      maxBytes: MAX_SNAPSHOT_ARCHIVE_BYTES,
      path,
    });
    if (!copied) throw new AppError("unknown_snapshot");
    const { snapshot, archive } = await readSnapshotFile(path, copied.size);
    const listed = new Map(
      (snapshot.files ?? []).map((file) => [file.id, file]),
    );
    return {
      snapshot,
      filename: copied.filename || "base.anygriddb.json",
      readFile: async (fileId, maxBytes) => {
        const file = listed.get(fileId);
        if (!archive || !file) return undefined;
        const bytes = await archive.read(`files/${fileId}`, maxBytes);
        if (
          !bytes ||
          createHash("sha256").update(bytes).digest("hex") !== file.sha256
        ) {
          throw new ZipError("Broken entry");
        }
        return bytes;
      },
      close: folder.remove,
    };
  } catch (error) {
    await folder.remove();
    throw error;
  }
}

export async function keepStagedSnapshot(
  db: Database,
  id: string,
): Promise<void> {
  await keepStagedUpload(db, id, QUEUED_TTL);
}

export async function dropStagedSnapshot(
  db: Database,
  files: FileStore,
  id: string,
): Promise<void> {
  await dropStagedUpload(db, files, id);
}
