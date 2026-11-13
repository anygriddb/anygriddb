import { AppError, labelSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { z } from "zod";
import { withAudit } from "./audit-context.js";
import { liveTable } from "./live.js";

/** A folder outside the trash. */
export const liveFolder = (alias = "tableFolders") =>
  sql<boolean>`${sql.ref(`${alias}.deletedAt`)} is null`;

export const createFolderInputSchema = z.object({
  baseId: z.uuid(),
  name: labelSchema,
});

export const updateFolderInputSchema = z.object({
  folderId: z.uuid(),
  name: labelSchema,
});

export const deleteFolderInputSchema = z.object({
  folderId: z.uuid(),
});

export const moveTableToFolderInputSchema = z.object({
  tableId: z.uuid(),
  /** `null` puts the table back at the root of the base. */
  folderId: z.uuid().nullable(),
});

export const reorderFoldersInputSchema = z.object({
  baseId: z.uuid(),
  order: z.array(z.uuid()).min(1).max(500),
});

export const reorderFolderTablesInputSchema = z.object({
  folderId: z.uuid(),
  order: z.array(z.uuid()).min(1).max(500),
});

export type FolderRow = {
  id: string;
  baseId: string;
  name: string;
  position: number;
};

export async function listFolders(
  db: Database,
  baseIds: readonly string[],
): Promise<FolderRow[]> {
  if (baseIds.length === 0) return [];
  return db
    .selectFrom("tableFolders")
    .select(["id", "baseId", "name", "position"])
    .where("baseId", "in", [...baseIds])
    .where(liveFolder())
    .orderBy("position", "asc")
    .orderBy("name", "asc")
    .execute();
}

async function folderOf(
  db: Database,
  folderId: string,
): Promise<FolderRow & { deletedAt: Date | null }> {
  const folder = await db
    .selectFrom("tableFolders")
    .select(["id", "baseId", "name", "position", "deletedAt"])
    .where("id", "=", folderId)
    .executeTakeFirst();
  if (!folder || folder.deletedAt) {
    throw new AppError("unknown_folder");
  }
  return folder;
}

export async function createFolder(
  db: Database,
  userId: string,
  input: z.infer<typeof createFolderInputSchema>,
): Promise<FolderRow> {
  try {
    return await withAudit(db, { userId, source: "web" }, async (tx) => {
      const counted = await tx
        .selectFrom("tableFolders")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("baseId", "=", input.baseId)
        .where(liveFolder())
        .executeTakeFirst();
      const folder = await tx
        .insertInto("tableFolders")
        .values({
          baseId: input.baseId,
          name: input.name,
          position: counted?.count ?? 0,
        })
        .returning(["id", "baseId", "name", "position"])
        .executeTakeFirst();
      if (!folder) throw new AppError("no_row");
      return folder;
    });
  } catch (error) {
    if (isUniqueName(error)) {
      throw new AppError("folder_already_exists", { cause: error });
    }
    throw error;
  }
}

export async function updateFolder(
  db: Database,
  userId: string,
  input: z.infer<typeof updateFolderInputSchema>,
): Promise<FolderRow> {
  const current = await folderOf(db, input.folderId);
  try {
    return await withAudit(db, { userId, source: "web" }, async (tx) => {
      const folder = await tx
        .updateTable("tableFolders")
        .set({ name: input.name })
        .where("id", "=", current.id)
        .where(liveFolder())
        .returning(["id", "baseId", "name", "position"])
        .executeTakeFirst();
      if (!folder) throw new AppError("unknown_folder");
      return folder;
    });
  } catch (error) {
    if (isUniqueName(error)) {
      throw new AppError("folder_already_exists", { cause: error });
    }
    throw error;
  }
}

/**
 * Soft-deletes the folder and puts its tables back at the root of the base.
 */
export async function deleteFolder(
  db: Database,
  userId: string,
  folderId: string,
): Promise<void> {
  const folder = await folderOf(db, folderId);
  await withAudit(db, { userId, source: "web" }, async (tx) => {
    const tables = await tx
      .selectFrom("dataTables")
      .select("id")
      .where("folderId", "=", folder.id)
      .where(liveTable())
      .execute();
    if (tables.length > 0) {
      const rootCount = await tx
        .selectFrom("dataTables")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("baseId", "=", folder.baseId)
        .where("folderId", "is", null)
        .where(liveTable())
        .executeTakeFirst();
      let next = rootCount?.count ?? 0;
      for (const table of tables) {
        await tx
          .updateTable("dataTables")
          .set({ folderId: null, position: next })
          .where("id", "=", table.id)
          .execute();
        next += 1;
      }
    }
    await tx
      .updateTable("tableFolders")
      .set({ deletedAt: new Date(), deletedBy: userId })
      .where("id", "=", folder.id)
      .execute();
  });
}

export async function moveTableToFolder(
  db: Database,
  userId: string,
  input: z.infer<typeof moveTableToFolderInputSchema>,
): Promise<void> {
  const table = await db
    .selectFrom("dataTables")
    .select(["id", "baseId", "folderId"])
    .where("id", "=", input.tableId)
    .where(liveTable())
    .executeTakeFirst();
  if (!table) throw new AppError("unknown_table");
  if (input.folderId) {
    const folder = await folderOf(db, input.folderId);
    if (folder.baseId !== table.baseId) {
      throw new AppError("folder_wrong_base");
    }
  }
  if ((table.folderId ?? null) === input.folderId) return;
  await withAudit(db, { userId, source: "web" }, async (tx) => {
    const counted = await tx
      .selectFrom("dataTables")
      .select(sql<number>`count(*)::int`.as("count"))
      .where("baseId", "=", table.baseId)
      .where("folderId", input.folderId === null ? "is" : "=", input.folderId)
      .where(liveTable())
      .executeTakeFirst();
    await tx
      .updateTable("dataTables")
      .set({ folderId: input.folderId, position: counted?.count ?? 0 })
      .where("id", "=", table.id)
      .execute();
  });
}

export async function reorderFolders(
  db: Database,
  userId: string,
  baseId: string,
  order: readonly string[],
): Promise<void> {
  const existing = await db
    .selectFrom("tableFolders")
    .select("id")
    .where("baseId", "=", baseId)
    .where(liveFolder())
    .execute();
  const ids = new Set(existing.map((row) => row.id));
  if (order.length !== ids.size || order.some((id) => !ids.has(id))) {
    throw new AppError("invalid_order");
  }
  await withAudit(db, { userId, source: "web" }, async (tx) => {
    for (const [index, id] of order.entries()) {
      await tx
        .updateTable("tableFolders")
        .set({ position: index })
        .where("id", "=", id)
        .execute();
    }
  });
}

export async function reorderFolderTables(
  db: Database,
  userId: string,
  folderId: string,
  order: readonly string[],
): Promise<void> {
  const folder = await folderOf(db, folderId);
  const existing = await db
    .selectFrom("dataTables")
    .select("id")
    .where("baseId", "=", folder.baseId)
    .where("folderId", "=", folder.id)
    .where(liveTable())
    .execute();
  const ids = new Set(existing.map((row) => row.id));
  if (order.length !== ids.size || order.some((id) => !ids.has(id))) {
    throw new AppError("invalid_order");
  }
  await withAudit(db, { userId, source: "web" }, async (tx) => {
    for (const [index, id] of order.entries()) {
      await tx
        .updateTable("dataTables")
        .set({ position: index })
        .where("id", "=", id)
        .execute();
    }
  });
}

function isUniqueName(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}
