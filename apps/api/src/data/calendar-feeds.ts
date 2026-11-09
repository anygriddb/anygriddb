/**
 * Private calendar feeds: the rows of a calendar view as an iCalendar
 * document a calendar application subscribes to. The address holds a
 * secret token, for one person and one view; only its SHA-256 is kept.
 * The feed reads what that person may read, under their field and row
 * rules, and stops when they lose access, the view goes, or they revoke
 * or renew the address.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  AppError,
  andFilters,
  buildICalendar,
  type CalendarEvent,
  type CalendarMoment,
  describeColumns,
  effectiveTableRole,
  normalizeViewConfig,
  roleAllows,
  viewFilter,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { loadBindings } from "../auth/access.js";
import { readerEngine } from "./acl.js";
import { withAudit } from "./audit-context.js";
import { readPage } from "./rows.js";

const TOKEN = /^agcal_[A-Za-z0-9_-]{43}$/;
/** Events from six months ago to two years ahead, 3,000 at most. */
const PAST_DAYS = 183;
const FUTURE_DAYS = 731;
const PAGE = 1_000;
const PAGES = 3;

function hashFeedToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A view a person may subscribe to: a calendar, shared or theirs. */
async function feedView(db: Database, viewId: string, userId: string) {
  const view = await db
    .selectFrom("views as v")
    .innerJoin("dataTables as t", "t.id", "v.tableId")
    .select([
      "v.id",
      "v.name",
      "v.viewType",
      "v.config",
      "v.ownerId",
      "v.tableId",
      "t.baseId",
      "t.name as tableName",
    ])
    .where("v.id", "=", viewId)
    .where("v.deletedAt", "is", null)
    .where("t.deletedAt", "is", null)
    .executeTakeFirst();
  if (
    !view ||
    view.viewType !== "calendar" ||
    (view.ownerId !== null && view.ownerId !== userId)
  ) {
    return undefined;
  }
  const bindings = await loadBindings(db, userId);
  const role = effectiveTableRole(bindings, view.tableId, view.baseId);
  if (!role || !roleAllows(role, "read")) return undefined;
  return { ...view, bindings };
}

/** Whether the person has a feed of the view, and since when. */
export async function calendarFeedOf(
  db: Database,
  userId: string,
  viewId: string,
): Promise<{ createdAt: Date; lastUsedAt: Date | null } | null> {
  if (!(await feedView(db, viewId, userId))) throw new AppError("invalid_view");
  const row = await db
    .selectFrom("calendarFeeds")
    .select(["createdAt", "lastUsedAt"])
    .where("viewId", "=", viewId)
    .where("userId", "=", userId)
    .executeTakeFirst();
  return row ?? null;
}

/** A new address for the person's feed of the view; the old one stops. */
export async function renewCalendarFeed(
  db: Database,
  userId: string,
  viewId: string,
): Promise<string> {
  const view = await feedView(db, viewId, userId);
  if (!view) throw new AppError("invalid_view");
  const token = `agcal_${randomBytes(32).toString("base64url")}`;
  await withAudit(
    db,
    { userId, tableId: view.tableId, source: "web" },
    async (tx) => {
      await tx
        .insertInto("calendarFeeds")
        .values({ viewId, userId, tokenHash: hashFeedToken(token) })
        .onConflict((conflict) =>
          conflict.columns(["viewId", "userId"]).doUpdateSet({
            tokenHash: hashFeedToken(token),
            createdAt: new Date(),
            lastUsedAt: null,
          }),
        )
        .execute();
    },
  );
  return token;
}

export async function revokeCalendarFeed(
  db: Database,
  userId: string,
  viewId: string,
): Promise<void> {
  const view = await feedView(db, viewId, userId);
  await withAudit(
    db,
    { userId, tableId: view?.tableId, source: "web" },
    async (tx) => {
      await tx
        .deleteFrom("calendarFeeds")
        .where("viewId", "=", viewId)
        .where("userId", "=", userId)
        .execute();
    },
  );
}

/** A row's date or time as the feed writes it. */
function momentOf(value: unknown, kind: string): CalendarMoment | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return kind === "date" ? { date: value.slice(0, 10) } : { instant: value };
}

/**
 * The feed's document, or null when the token names no feed it may still
 * read: the response is then the same whatever the reason.
 */
export async function calendarFeedDocument(
  db: Database,
  token: string,
  publicUrl: string,
  now: Date = new Date(),
): Promise<string | null> {
  if (!TOKEN.test(token)) return null;
  const feed = await db
    .selectFrom("calendarFeeds as f")
    .innerJoin("users as u", "u.id", "f.userId")
    .select(["f.id", "f.viewId", "f.userId", "f.lastUsedAt"])
    .where("f.tokenHash", "=", hashFeedToken(token))
    .where("u.disabledAt", "is", null)
    .executeTakeFirst();
  if (!feed) return null;
  const view = await feedView(db, feed.viewId, feed.userId);
  if (!view) return null;
  if (!feed.lastUsedAt || now.getTime() - feed.lastUsedAt.getTime() > 60_000) {
    await db
      .updateTable("calendarFeeds")
      .set({ lastUsedAt: now })
      .where("id", "=", feed.id)
      .execute();
  }
  const { engine } = await readerEngine(db, view.tableId, {
    userId: feed.userId,
    bindings: view.bindings,
  });
  const config = normalizeViewConfig(view.config, "calendar");
  const kinds = new Map(
    describeColumns(engine).map((column) => [column.name, column.kind]),
  );
  const dated = (name: unknown) =>
    typeof name === "string" &&
    (kinds.get(name) === "date" || kinds.get(name) === "datetime")
      ? name
      : undefined;
  const start =
    dated(config.startColumn) ??
    [...kinds].find(([, kind]) => kind === "date" || kind === "datetime")?.[0];
  if (!start) return null;
  const end = dated(config.endColumn);
  const primary = engine.table.primaryColumn;
  const day = (offset: number) =>
    new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const filter = andFilters(viewFilter(config), {
    conjunction: "and",
    conditions: [
      {
        column: start,
        op: "is_between",
        value: [day(-PAST_DAYS), day(FUTURE_DAYS)],
      },
    ],
  });
  const fields = [start, ...(end ? [end] : []), ...(primary ? [primary] : [])];
  const host = new URL(publicUrl).hostname;
  const events: CalendarEvent[] = [];
  for (let page = 0; page < PAGES; page += 1) {
    const read = await readPage(
      db,
      engine,
      {
        limit: PAGE,
        offset: page * PAGE,
        sort: [{ column: start, direction: "asc" }],
        fields: [...new Set(fields)],
        timeZone: "UTC",
        ...(filter ? { filter } : {}),
      },
      { total: false },
    );
    for (const row of read.rows) {
      const from = momentOf(row[start], kinds.get(start) ?? "date");
      if (!from) continue;
      const to = end ? momentOf(row[end], kinds.get(end) ?? "date") : undefined;
      const title = primary ? row[primary] : undefined;
      events.push({
        uid: `${row.id}.${view.tableId}@${host}`,
        summary:
          typeof title === "string" || typeof title === "number"
            ? String(title)
            : row.id,
        start: from,
        ...(to ? { end: to } : {}),
        url: `${publicUrl}/b/${view.baseId}/t/${view.tableId}?row=${encodeURIComponent(row.id)}`,
      });
    }
    if (read.rows.length < PAGE) break;
  }
  return buildICalendar({
    name: `${view.name} — ${view.tableName}`,
    events,
    now,
  });
}
