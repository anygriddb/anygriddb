import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { AppError } from "@anygriddb/core";

export async function listComments(
  db: Database,
  tableId: string,
  rowId: string,
) {
  const rows = await db
    .selectFrom("comments as c")
    .innerJoin("users as u", "u.id", "c.authorId")
    .select([
      "c.id",
      "c.body",
      "c.parentId",
      "c.authorId",
      "c.createdAt",
      "c.updatedAt",
      "c.deletedAt",
      "u.displayName",
    ])
    .where("c.tableId", "=", tableId)
    .where("c.rowId", "=", rowId)
    .orderBy("c.createdAt", "asc")
    .limit(500)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    body: row.deletedAt ? "" : row.body,
    parentId: row.parentId,
    authorId: row.authorId,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    deleted: row.deletedAt !== null,
  }));
}

export async function countComments(
  db: Database,
  tableId: string,
  rowIds: readonly string[],
) {
  if (rowIds.length === 0) {
    return {};
  }
  const rows = await db
    .selectFrom("comments")
    .select(["rowId", sql<number>`count(*)::int`.as("count")])
    .where("tableId", "=", tableId)
    .where("rowId", "in", [...rowIds])
    .where("deletedAt", "is", null)
    .groupBy("rowId")
    .execute();
  return Object.fromEntries(rows.map((row) => [row.rowId, row.count]));
}

export async function commentTableId(
  db: Database,
  commentId: string,
): Promise<string> {
  const row = await db
    .selectFrom("comments")
    .select("tableId")
    .where("id", "=", commentId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("no_row");
  }
  return row.tableId;
}

export async function addComment(
  db: Database,
  input: {
    tableId: string;
    rowId: string;
    authorId: string;
    body: string;
    parentId?: string;
  },
) {
  if (input.parentId) {
    const parent = await db
      .selectFrom("comments")
      .select(["tableId", "rowId", "parentId"])
      .where("id", "=", input.parentId)
      .executeTakeFirst();
    if (
      !parent ||
      parent.tableId !== input.tableId ||
      parent.rowId !== input.rowId ||
      parent.parentId
    ) {
      throw new AppError("invalid_comment");
    }
  }
  const inserted = await db
    .insertInto("comments")
    .values({
      tableId: input.tableId,
      rowId: input.rowId,
      authorId: input.authorId,
      body: input.body,
      parentId: input.parentId ?? null,
    })
    .returning("id")
    .executeTakeFirst();
  if (!inserted) {
    throw new AppError("no_row");
  }
  return { id: inserted.id };
}

export async function updateComment(
  db: Database,
  commentId: string,
  userId: string,
  body: string,
) {
  const updated = await db
    .updateTable("comments")
    .set({ body, updatedAt: new Date() })
    .where("id", "=", commentId)
    .where("authorId", "=", userId)
    .where("deletedAt", "is", null)
    .returning("id")
    .execute();
  if (updated.length === 0) {
    throw new AppError("access_denied");
  }
}

/** Soft delete keeps the thread shape; the body is no longer served. */
export async function deleteComment(
  db: Database,
  commentId: string,
  userId: string,
  owner: boolean,
) {
  let query = db
    .updateTable("comments")
    .set({ deletedAt: new Date() })
    .where("id", "=", commentId)
    .where("deletedAt", "is", null);
  if (!owner) query = query.where("authorId", "=", userId);
  const updated = await query.returning("id").execute();
  if (updated.length === 0) {
    throw new AppError("access_denied");
  }
}
