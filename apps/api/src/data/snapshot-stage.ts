/**
 * Uploaded snapshots, until their import job runs: a JSON file, or a ZIP
 * archive that also holds the attachments' files (ADR 0039) and, in version
 * 3, each table's rows as lines of their own entry (ADR 0076). Both are
 * checked at upload, so a broken file is refused then, not in the job.
 */
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppError,
  type BaseSnapshot,
  claimsRowState,
  MAX_SNAPSHOT_ARCHIVE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_TABLES,
  SNAPSHOT_ENTRY,
  SNAPSHOT_KEPT_VERSION,
  SNAPSHOT_VERSION,
  type SnapshotLine,
  snapshotRowCount,
  snapshotRowsEntry,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FileStore } from "../files/index.js";
import { localFolder } from "../files/local-folder.js";
import { parseSnapshotBytes, readSnapshotLines } from "./base-snapshot.js";
import {
  copyStagedUpload,
  dropStagedUpload,
  keepStagedUpload,
  stageUploadFile,
} from "./staged-uploads.js";
import { isZip, ZipError, ZipReader } from "./zip.js";

type SnapshotColumns = BaseSnapshot["tables"][number]["columns"];

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
    const snapshot = parseSnapshotBytes(await readFile(path));
    // A version 3 snapshot's rows live in an archive's entries.
    if (
      snapshot.version >= SNAPSHOT_VERSION &&
      snapshotRowCount(snapshot) > 0
    ) {
      throw new AppError("invalid_snapshot");
    }
    return { snapshot };
  }
  if (size > MAX_SNAPSHOT_ARCHIVE_BYTES) {
    throw new AppError("too_large_snapshot");
  }
  try {
    const archive = await ZipReader.open(path, {
      maxEntries: MAX_SNAPSHOT_FILES + MAX_SNAPSHOT_TABLES + 1,
    });
    const bytes = await archive.read(SNAPSHOT_ENTRY, MAX_SNAPSHOT_BYTES);
    if (!bytes) throw new AppError("invalid_snapshot");
    const snapshot = parseSnapshotBytes(bytes);
    for (const file of snapshot.files ?? []) {
      if (archive.entries.get(`files/${file.id}`)?.size !== file.size) {
        throw new AppError("invalid_snapshot");
      }
    }
    // Every table's rows are there and whole, read through once.
    for (const table of snapshot.tables) {
      if (table.rowCount) await archive.check(snapshotRowsEntry(table.key));
    }
    return { snapshot, archive };
  } catch (error) {
    if (error instanceof ZipError) {
      throw new AppError("invalid_snapshot", { cause: error });
    }
    throw error;
  }
}

/** The form an instance keeps for itself is never taken from a file. */
function assertPortable(snapshot: BaseSnapshot): void {
  if (snapshot.version === SNAPSHOT_KEPT_VERSION) {
    throw new AppError("invalid_snapshot");
  }
}

/** Lines read between two looks at whether the job should stop. */
const VERIFY_LINES = 1_000;

/**
 * Reads a whole uploaded snapshot before a base is made of it: every listed
 * file against its SHA-256, every line against its schema and its table's
 * count. A row that says what state it is in is refused: only the
 * instance's own copies are believed on that (ADR 0117).
 */
async function verifySnapshot(
  snapshot: BaseSnapshot,
  archive: ZipReader | undefined,
  onWork: () => Promise<void>,
): Promise<void> {
  const fieldsOf = (key: string, columns: SnapshotColumns) =>
    new Set([
      ...columns.flatMap((column) => (column.name ? [column.name] : [])),
      ...snapshot.links.flatMap((link) => [
        ...(link.from === key && link.name ? [link.name] : []),
        ...(link.to === key && link.inverseName ? [link.inverseName] : []),
      ]),
    ]);
  try {
    // A JSON file holds no file of its own: its import counts them missing.
    for (const file of archive ? (snapshot.files ?? []) : []) {
      const hash = createHash("sha256");
      await archive?.check(`files/${file.id}`, (chunk) => hash.update(chunk));
      if (hash.digest("hex") !== file.sha256) {
        throw new AppError("invalid_snapshot");
      }
      await onWork();
    }
    for (const table of snapshot.tables) {
      const fields = fieldsOf(table.key, table.columns);
      if (table.rows?.some((row) => claimsRowState(row, fields))) {
        throw new AppError("invalid_snapshot");
      }
      if (!table.rowCount) continue;
      if (!archive) throw new AppError("invalid_snapshot");
      let count = 0;
      for await (const line of readSnapshotLines(archive, table.key)) {
        if (claimsRowState(line, fields)) {
          throw new AppError("invalid_snapshot");
        }
        count += 1;
        if (count % VERIFY_LINES === 0) await onWork();
      }
      if (count !== table.rowCount) throw new AppError("invalid_snapshot");
    }
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
  assertPortable(snapshot);
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
  /** Version 3: a table's lines, read from its entry; none otherwise. */
  readLines: (key: string) => AsyncIterable<SnapshotLine>;
  /**
   * Reads the whole file, and refuses it if any of it is broken or claims
   * a row's state. `onWork` runs now and then, and may stop it.
   */
  verify: (onWork: () => Promise<void>) => Promise<void>;
  /** Removes the local copy. */
  close: () => Promise<void>;
};

/**
 * A snapshot in a local file, checked as an upload is: its JSON, and
 * readers for its files and its lines (an archive's; none for JSON).
 * `own` is for a copy this instance made: its lines keep the numbers its
 * tables hold, and their state.
 */
export async function openLocalSnapshot(
  path: string,
  size: number,
  options: { own?: boolean } = {},
): Promise<
  Pick<OpenedSnapshot, "snapshot" | "readFile" | "readLines" | "verify">
> {
  const { snapshot, archive } = await readSnapshotFile(path, size);
  const listed = new Map((snapshot.files ?? []).map((file) => [file.id, file]));
  return {
    snapshot,
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
    readLines: (key) =>
      archive ? readSnapshotLines(archive, key, options) : noLines(),
    verify: (onWork) => verifySnapshot(snapshot, archive, onWork),
  };
}

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
    const opened = await openLocalSnapshot(path, copied.size);
    assertPortable(opened.snapshot);
    return {
      ...opened,
      filename: copied.filename || "base.anygriddb.json",
      close: folder.remove,
    };
  } catch (error) {
    await folder.remove();
    throw error;
  }
}

async function* noLines(): AsyncGenerator<SnapshotLine> {
  // A JSON snapshot carries its rows inside it.
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
