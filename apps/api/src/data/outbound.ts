/**
 * What lets a view be read from outside its base, across the instance:
 * public links and private calendar feeds. Metadata only, for an
 * administrator: never a cell value, a token, or a password.
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { withAudit } from "./audit-context.js";
import { liveBase, liveTable, liveView } from "./live.js";

export type OutboundLink = {
  kind: "link" | "feed";
  id: string;
  baseId: string;
  base: string;
  table: string;
  view: string;
  author: string;
  createdAt: string;
  /** A public link's end, if it has one. */
  expiresAt: string | null;
  expired: boolean;
  /** A public link asks for a password. */
  protected: boolean;
  /** When a calendar feed was last read; a link's use is not recorded. */
  lastUsedAt: string | null;
};

/**
 * Every public link not revoked, and every calendar feed, of a live view
 * of a live table of a live base: newest first, at most `limit` of each.
 */
export async function listOutbound(
  db: Database,
  limit: number,
): Promise<OutboundLink[]> {
  const now = Date.now();
  const [links, feeds] = await Promise.all([
    db
      .selectFrom("shares as s")
      .innerJoin("users as u", "u.id", "s.createdBy")
      .innerJoin("views as v", "v.id", "s.viewId")
      .innerJoin("dataTables as t", "t.id", "v.tableId")
      .innerJoin("bases as b", "b.id", "t.baseId")
      .select([
        "s.id",
        "s.createdAt",
        "s.expiresAt",
        "s.passwordHash",
        "u.displayName as author",
        "v.name as view",
        "t.name as table",
        "b.id as baseId",
        "b.name as base",
      ])
      .where("s.revokedAt", "is", null)
      .where(liveView("v"))
      .where(liveTable("t"))
      .where(liveBase("b"))
      .orderBy("s.createdAt", "desc")
      .limit(limit)
      .execute(),
    db
      .selectFrom("calendarFeeds as f")
      .innerJoin("users as u", "u.id", "f.userId")
      .innerJoin("views as v", "v.id", "f.viewId")
      .innerJoin("dataTables as t", "t.id", "v.tableId")
      .innerJoin("bases as b", "b.id", "t.baseId")
      .select([
        "f.id",
        "f.createdAt",
        "f.lastUsedAt",
        "u.displayName as author",
        "v.name as view",
        "t.name as table",
        "b.id as baseId",
        "b.name as base",
      ])
      .where(liveView("v"))
      .where(liveTable("t"))
      .where(liveBase("b"))
      .orderBy("f.createdAt", "desc")
      .limit(limit)
      .execute(),
  ]);
  return [
    ...links.map((row): OutboundLink => ({
      kind: "link",
      id: row.id,
      baseId: row.baseId,
      base: row.base,
      table: row.table,
      view: row.view,
      author: row.author,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
      protected: row.passwordHash !== null,
      lastUsedAt: null,
    })),
    ...feeds.map((row): OutboundLink => ({
      kind: "feed",
      id: row.id,
      baseId: row.baseId,
      base: row.base,
      table: row.table,
      view: row.view,
      author: row.author,
      createdAt: row.createdAt.toISOString(),
      expiresAt: null,
      expired: false,
      protected: false,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * Revokes a public link, or removes a calendar feed, for an administrator
 * who need not be a member of its base. A feed's removal is on the change
 * trail under their name, as its owner's would be.
 */
export async function revokeOutbound(
  db: Database,
  adminId: string,
  target: { kind: "link" | "feed"; id: string },
): Promise<void> {
  if (target.kind === "link") {
    const row = await db
      .updateTable("shares")
      .set({ revokedAt: new Date() })
      .where("id", "=", target.id)
      .where("revokedAt", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!row) throw new AppError("no_row");
    return;
  }
  const feed = await db
    .selectFrom("calendarFeeds as f")
    .innerJoin("views as v", "v.id", "f.viewId")
    .select(["f.id", "v.tableId"])
    .where("f.id", "=", target.id)
    .executeTakeFirst();
  if (!feed) throw new AppError("no_row");
  await withAudit(
    db,
    { userId: adminId, tableId: feed.tableId, source: "web" },
    (tx) => tx.deleteFrom("calendarFeeds").where("id", "=", feed.id).execute(),
  );
}
