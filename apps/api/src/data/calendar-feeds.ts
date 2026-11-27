/**
 * Private calendar feeds: the rows of a calendar view as an iCalendar
 * document a calendar application subscribes to. The address holds a
 * secret token, for one person and one view; only its SHA-256 is kept.
 * The feed reads what that person may read, under their field and row
 * rules, and stops when they lose access, the view goes, or they revoke
 * or renew the address.
 */
import { randomBytes } from "node:crypto";
import { hashSecret, liveAccess } from "../auth/delegated.js";
import {
  AppError,
  andFilters,
  buildICalendar,
  type CalendarEvent,
  type CalendarMoment,
  describeColumns,
  effectiveTableRole,
  normalizeViewConfig,
  viewFilter,
  ceilingOf,
} from "@anygriddb/core";
import { granted } from "../access/declaration.js";
import type { Database } from "@anygriddb/db";
import { authorBindings } from "../auth/access.js";
import type { ReadBudget } from "../read-budget.js";
import { readerEngine } from "./acl.js";
import { withAudit } from "./audit-context.js";
import { readPage } from "./rows.js";

const TOKEN = /^agcal_[A-Za-z0-9_-]{43}$/;
/** Events from six months ago to two years ahead, 3,000 at most. */
const PAST_DAYS = ceilingOf("feed.past_days");
const FUTURE_DAYS = ceilingOf("feed.future_days");
const PAGE = 1_000;
const PAGES = 3;

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
  // A feed is read without its owner: their roles now, none if disabled.
  const bindings = await authorBindings(db, userId);
  const role = effectiveTableRole(bindings, view.tableId, view.baseId);
  if (!granted(role, "data.export")) return undefined;
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
    .selectFrom("delegatedAccesses")
    .select(["createdAt", "lastUsedAt"])
    .where("kind", "=", "feed")
    .where("viewId", "=", viewId)
    .where("authorId", "=", userId)
    .where("revokedAt", "is", null)
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
      // The person's live feed of the view takes the new secret; with none,
      // one is made.
      const renewed = await tx
        .updateTable("delegatedAccesses")
        .set({
          secretHash: hashSecret(token),
          createdAt: new Date(),
          lastUsedAt: null,
        })
        .where("kind", "=", "feed")
        .where("viewId", "=", viewId)
        .where("authorId", "=", userId)
        .where("revokedAt", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (renewed) return;
      await tx
        .insertInto("delegatedAccesses")
        .values({
          kind: "feed",
          name: "",
          viewId,
          authorId: userId,
          secretHash: hashSecret(token),
        })
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
        .updateTable("delegatedAccesses")
        .set({ revokedAt: new Date() })
        .where("kind", "=", "feed")
        .where("viewId", "=", viewId)
        .where("authorId", "=", userId)
        .where("revokedAt", "is", null)
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
  budget?: ReadBudget,
): Promise<string | null> {
  if (!TOKEN.test(token)) return null;
  const feed = await db
    .selectFrom("delegatedAccesses as a")
    .innerJoin("users as u", "u.id", "a.authorId")
    .select(["a.id", "a.viewId", "a.authorId as userId", "a.lastUsedAt"])
    .where("a.kind", "=", "feed")
    .where("a.secretHash", "=", hashSecret(token))
    .where(liveAccess)
    .where("u.disabledAt", "is", null)
    .executeTakeFirst();
  if (!feed?.viewId) return null;
  const view = await feedView(db, feed.viewId, feed.userId);
  if (!view) return null;
  if (!feed.lastUsedAt || now.getTime() - feed.lastUsedAt.getTime() > 60_000) {
    await db
      .updateTable("delegatedAccesses")
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
      { total: false, budget },
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
