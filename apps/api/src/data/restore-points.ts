/**
 * A base's restore points (ADR 0077): its snapshot, rows and files
 * included, kept in the files' store under `restore-points/<id>`, listed on
 * the base's page, read back into a new base in one step, and removed with
 * its file when it ends, when it is deleted, or when its base is purged.
 */
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  AppError,
  type MadeNames,
  MAX_RESTORE_POINTS,
  type RestorePoint,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { assertFileKey, deleteFiles, type FileStore } from "../files/index.js";
import { localFolder } from "../files/local-folder.js";
import { listGroupRoles, setGroupRole } from "../scim/groups.js";
import { readSettings } from "../settings.js";
import { importBaseSnapshot, writeBaseSnapshot } from "./base-snapshot.js";
import { recordExport } from "./export-audit.js";
import { liveBase } from "./live.js";
import { baseCollaboratorIds } from "./rows.js";
import { openLocalSnapshot } from "./snapshot-stage.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Points the nightly purge removes at most in one run. */
const PURGE_BATCH = 1_000;

/** Where a restore point's archive is kept: one per point. */
export function restorePointKey(id: string): string {
  const key = `restore-points/${id}`;
  assertFileKey(key);
  return key;
}

/**
 * When a point ends: its own date, or sooner when the instance now keeps
 * points for less time than when it was made.
 */
function endOf(days: number) {
  return sql<Date>`least(p.expires_at, p.created_at + make_interval(days => ${days}))`;
}

/** How many days the instance keeps a restore point now. */
async function keepDays(db: Database): Promise<number> {
  return (await readSettings(db)).restorePointDays;
}

/** A base's restore points that have not ended, newest first. */
export async function listRestorePoints(
  db: Database,
  baseId: string,
  now: Date = new Date(),
): Promise<RestorePoint[]> {
  const ends = endOf(await keepDays(db));
  const rows = await db
    .selectFrom("restorePoints as p")
    .leftJoin("users as u", "u.id", "p.createdBy")
    .select([
      "p.id",
      "p.baseId",
      "p.createdAt",
      ends.as("endsAt"),
      "p.size",
      "p.rows",
      "p.files",
      "p.note",
      "u.id as authorId",
      "u.displayName as authorName",
    ])
    .where("p.baseId", "=", baseId)
    .where(ends, ">", now)
    .orderBy("p.createdAt", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    baseId: row.baseId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: new Date(row.endsAt).toISOString(),
    createdBy:
      row.authorId === null
        ? null
        : { id: row.authorId, name: row.authorName ?? "" },
    size: Number(row.size),
    rows: Number(row.rows),
    files: row.files,
    note: row.note,
  }));
}

/** The restore point, while it has not ended, and its base. */
export async function findRestorePoint(
  db: Database,
  id: string,
  now: Date = new Date(),
): Promise<{ id: string; baseId: string; fileKey: string; size: number }> {
  const found = await db
    .selectFrom("restorePoints as p")
    .select(["p.id", "p.baseId", "p.fileKey", "p.size"])
    .where("p.id", "=", id)
    .where(endOf(await keepDays(db)), ">", now)
    .executeTakeFirst();
  if (!found) throw new AppError("unknown_restore_point");
  return { ...found, size: Number(found.size) };
}

/**
 * Writes a base's snapshot with its data and files, keeps it in the store,
 * and lists it on the base, until the instance's `restorePointDays` pass.
 * A base keeps `MAX_RESTORE_POINTS` at most: one more is refused until one
 * is deleted or ends.
 */
export async function makeRestorePoint(
  deps: { db: Database; files: FileStore; maxRows: number },
  input: {
    userId: string;
    baseId: string;
    note?: string;
    onProgress?: (done: number, total: number | null) => Promise<void>;
  },
): Promise<{ id: string; rows: number; size: number; files: number }> {
  const { db, files } = deps;
  const now = new Date();
  const days = await keepDays(db);
  const kept = await db
    .selectFrom("restorePoints as p")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("p.baseId", "=", input.baseId)
    .where(endOf(days), ">", now)
    .executeTakeFirst();
  if (Number(kept?.count ?? 0) >= MAX_RESTORE_POINTS) {
    throw new AppError("restore_points_full");
  }
  const id = randomUUID();
  const key = restorePointKey(id);
  const folder = await localFolder("snapshot");
  try {
    const written = await writeBaseSnapshot(db, files, input.baseId, {
      withData: true,
      folder: folder.path,
      maxRows: deps.maxRows,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    });
    if (written.packed.kind !== "zip") throw new AppError("invalid_snapshot");
    // The file first, its line after: a file whose line never came, the
    // process stopped between them, is the orphan sweep's.
    await files.putFile(key, {
      body: createReadStream(written.packed.path),
      size: written.packed.size,
      contentType: "application/zip",
    });
    try {
      await db
        .insertInto("restorePoints")
        .values({
          id,
          baseId: input.baseId,
          createdBy: input.userId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + days * DAY_MS),
          fileKey: key,
          size: written.packed.size,
          rows: written.rows,
          files: written.files,
          note: input.note ?? null,
        })
        .execute();
    } catch (error) {
      await files.delete(key).catch(() => undefined);
      throw error;
    }
    // A copy of the base's data, kept in the instance: on the trail as
    // its exports are, by its kind and its rows.
    await recordExport(db, {
      userId: input.userId,
      source: "web",
      export: {
        kind: "restore_point",
        format: "zip",
        rows: written.rows,
        baseId: input.baseId,
      },
    });
    return {
      id,
      rows: written.rows,
      size: written.packed.size,
      files: written.files,
    };
  } finally {
    await folder.remove();
  }
}

/**
 * Reads a restore point back into a new base, named after the base it was
 * made of: its rows, links, files, and views, and the access its members
 * had then, roles and rules, for those still in the base now. The base's
 * groups get the role they have on it now: a snapshot keeps no group.
 */
export async function restoreFromPoint(
  deps: {
    db: Database;
    files: FileStore;
    maxRows: number;
    maxFileBytes: number;
    names: MadeNames;
  },
  input: {
    userId: string;
    restorePointId: string;
    name?: string;
    onCreated?: (baseId: string) => void;
    onProgress?: (done: number, total: number | null) => Promise<void>;
  },
) {
  const { db, files } = deps;
  const point = await findRestorePoint(db, input.restorePointId);
  const folder = await localFolder("snapshot");
  try {
    const path = join(folder.path, "restore-point");
    const stored = await files.open(point.fileKey);
    if (!stored) throw new AppError("unknown_restore_point");
    await pipeline(
      stored.body,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
    const opened = await openLocalSnapshot(path, point.size);
    const source = await db
      .selectFrom("bases")
      .select("name")
      .where("id", "=", point.baseId)
      .where(liveBase())
      .executeTakeFirst();
    const stillIn = await baseCollaboratorIds(db, point.baseId);
    const groups = await listGroupRoles(db, point.baseId);
    return await importBaseSnapshot(db, files, input.userId, opened.snapshot, {
      name:
        input.name ??
        deps.names
          .restored(source?.name ?? opened.snapshot.base.name)
          .slice(0, 100),
      restoreMembers: true,
      keepAccounts: stillIn,
      beforeRows: async (baseId) => {
        for (const group of groups) {
          await setGroupRole(db, input.userId, {
            baseId,
            groupId: group.groupId,
            role: group.role,
          });
        }
      },
      readFile: opened.readFile,
      readLines: opened.readLines,
      maxRows: deps.maxRows,
      maxFileBytes: deps.maxFileBytes,
      names: deps.names,
      ...(input.onCreated ? { onCreated: input.onCreated } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    });
  } finally {
    await folder.remove();
  }
}

/**
 * Deletes one restore point: its line, then its file. A file the store
 * fails to delete is reported, and left to the orphan sweep.
 */
export async function deleteRestorePoint(
  db: Database,
  files: FileStore,
  id: string,
  onFileError: (error: unknown) => void,
): Promise<void> {
  const deleted = await db
    .deleteFrom("restorePoints")
    .where("id", "=", id)
    .returning("fileKey")
    .executeTakeFirst();
  if (!deleted) throw new AppError("unknown_restore_point");
  await deleteFiles(files, [deleted.fileKey], onFileError);
}

/**
 * Removes the restore points that have ended, a thousand at most a run:
 * their lines, then their files.
 */
export async function purgeRestorePoints(
  db: Database,
  files: FileStore,
  onFileError: (error: unknown) => void,
  now: Date = new Date(),
): Promise<number> {
  const ends = endOf(await keepDays(db));
  const due = await db
    .selectFrom("restorePoints as p")
    .select("p.id")
    .where(ends, "<=", now)
    .orderBy(ends)
    .limit(PURGE_BATCH)
    .execute();
  if (due.length === 0) return 0;
  const deleted = await db
    .deleteFrom("restorePoints")
    .where(
      "id",
      "in",
      due.map((point) => point.id),
    )
    .returning("fileKey")
    .execute();
  await deleteFiles(
    files,
    deleted.map((point) => point.fileKey),
    onFileError,
  );
  return deleted.length;
}
