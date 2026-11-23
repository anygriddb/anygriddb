import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { AppError } from "@anygriddb/core";

/** Comments of a row listed at once: its latest, oldest first. */
const MAX_COMMENTS_LISTED = 500;

export async function listComments(
  db: Database,
  tableId: string,
  rowId: string,
) {
  const rows = await db
    .selectFrom("comments as c")
    .innerJoin("users as u", "u.id", "c.authorId")
    .leftJoin("users as r", "r.id", "c.resolvedBy")
    .select([
      "c.id",
      "c.body",
      "c.parentId",
      "c.authorId",
      "c.createdAt",
      "c.updatedAt",
      "c.deletedAt",
      "c.resolvedAt",
      "u.displayName",
      "r.displayName as resolvedByName",
    ])
    .where("c.tableId", "=", tableId)
    .where("c.rowId", "=", rowId)
    // The latest ones, when a row has more than are listed: the oldest
    // five hundred hid what was just said.
    .orderBy("c.createdAt", "desc")
    .orderBy("c.id", "desc")
    .limit(MAX_COMMENTS_LISTED)
    .execute();
  return rows.reverse().map((row) => ({
    id: row.id,
    body: row.deletedAt ? "" : row.body,
    parentId: row.parentId,
    authorId: row.authorId,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    deleted: row.deletedAt !== null,
    // A thread is resolved on its first comment; who did may be gone.
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByName: row.resolvedAt ? row.resolvedByName : null,
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

/** The table and the row a comment is on. */
export async function commentPlace(
  db: Database,
  commentId: string,
): Promise<{ tableId: string; rowId: string }> {
  const row = await db
    .selectFrom("comments")
    .select(["tableId", "rowId"])
    .where("id", "=", commentId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("no_row");
  }
  return row;
}

/**
 * Resolves a thread, or opens it again: said of its first comment, by
 * anyone who may comment on the row. A reply is no thread, and a deleted
 * comment keeps none. Resolving what is resolved, or opening what is
 * open, changes nothing: the first to do it stays the one who did.
 */
export async function resolveComment(
  db: Database,
  input: { commentId: string; userId: string; resolved: boolean },
): Promise<void> {
  const thread = await db
    .selectFrom("comments")
    .select(["parentId", "deletedAt"])
    .where("id", "=", input.commentId)
    .executeTakeFirst();
  if (!thread || thread.parentId !== null || thread.deletedAt !== null) {
    throw new AppError("invalid_comment");
  }
  await db
    .updateTable("comments")
    .set(
      input.resolved
        ? { resolvedAt: new Date(), resolvedBy: input.userId }
        : { resolvedAt: null, resolvedBy: null },
    )
    .where("id", "=", input.commentId)
    .where("deletedAt", "is", null)
    .where("resolvedAt", input.resolved ? "is" : "is not", null)
    .execute();
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
      .select(["tableId", "rowId", "parentId", "deletedAt"])
      .where("id", "=", input.parentId)
      .executeTakeFirst();
    if (
      !parent ||
      parent.tableId !== input.tableId ||
      parent.rowId !== input.rowId ||
      parent.parentId ||
      parent.deletedAt
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
  // Someone has more to say: a reply opens a resolved thread again.
  if (input.parentId) {
    await db
      .updateTable("comments")
      .set({ resolvedAt: null, resolvedBy: null })
      .where("id", "=", input.parentId)
      .where("resolvedAt", "is not", null)
      .execute();
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
