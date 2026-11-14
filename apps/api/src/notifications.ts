import { effectiveTableRole, roleAllows, type RowEvent } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql as sqlTag } from "kysely";
import type { Publisher } from "./realtime/bus.js";
import { gridChannel } from "./realtime/channels.js";
import { readMailVoice } from "./settings.js";
import { liveColumn, liveTable } from "./data/live.js";
import { notificationMailBody, notificationMailSubject } from "./mail-i18n.js";
import { sendMail, smtpReady, type SmtpConfig } from "./mail.js";

export type NotificationKind =
  | "mention"
  | "reply"
  | "assigned"
  | "automation"
  | "webhook_disabled"
  | "row_changed";

export type NotificationInput = {
  userId: string;
  kind: NotificationKind;
  actorId?: string | null;
  tableId?: string | null;
  rowId?: string | null;
  commentId?: string | null;
  data?: Record<string, string>;
};

export type NotifyDeps = {
  db: Database;
  bus: Publisher;
  smtp: SmtpConfig;
  webOrigin: string;
  log: (error: unknown, message: string) => void;
};

const READ_RETENTION_DAYS = 90;
const UNREAD_RETENTION_DAYS = 180;

/** Who among `userIds` can still read the table: nobody is told about rows they cannot see. */
async function readersOf(
  db: Database,
  table: { id: string; baseId: string },
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const bindings = await db
    .selectFrom("roleBindings")
    .select(["userId", "role", "scope", "scopeId"])
    .where("userId", "in", [...userIds])
    .where("scopeId", "in", [table.id, table.baseId])
    .execute();
  const readers = new Set<string>();
  for (const userId of userIds) {
    const own = bindings.filter((binding) => binding.userId === userId);
    if (roleAllows(effectiveTableRole(own, table.id, table.baseId), "read")) {
      readers.add(userId);
    }
  }
  return readers;
}

/**
 * Stores notifications, tells each recipient's open tabs, and emails those
 * who asked for it. Nobody is notified of their own action, and a row
 * notification only reaches people who can read the table.
 */
export async function notify(
  deps: NotifyDeps,
  items: readonly NotificationInput[],
): Promise<number> {
  const seen = new Set<string>();
  const wanted = items.filter((item) => {
    if (item.actorId && item.actorId === item.userId) return false;
    const key = `${item.userId}:${item.kind}:${item.rowId ?? ""}:${item.commentId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (wanted.length === 0) return 0;
  const tableIds = [
    ...new Set(wanted.flatMap((item) => (item.tableId ? [item.tableId] : []))),
  ];
  const tableRows = tableIds.length
    ? await deps.db
        .selectFrom("dataTables")
        .select(["id", "baseId", "name"])
        .where("id", "in", tableIds)
        .where(liveTable())
        .execute()
    : [];
  const byId = new Map(tableRows.map((table) => [table.id, table]));
  const allowed: NotificationInput[] = [];
  for (const table of tableRows) {
    const forTable = wanted.filter((item) => item.tableId === table.id);
    const readers = await readersOf(
      deps.db,
      table,
      forTable.map((item) => item.userId),
    );
    allowed.push(...forTable.filter((item) => readers.has(item.userId)));
  }
  if (allowed.length === 0) return 0;
  await deps.db
    .insertInto("notifications")
    .values(
      allowed.map((item) => ({
        userId: item.userId,
        kind: item.kind,
        actorId: item.actorId ?? null,
        tableId: item.tableId ?? null,
        rowId: item.rowId ?? null,
        commentId: item.commentId ?? null,
        data: item.data ?? null,
      })),
    )
    .execute();
  const recipients = [...new Set(allowed.map((item) => item.userId))];
  for (const userId of recipients) {
    try {
      await deps.bus.publish(
        gridChannel(userId),
        JSON.stringify({ type: "notification", channel: userId }),
      );
    } catch (error) {
      deps.log(error, "notification publish failed");
    }
  }
  if (!smtpReady(deps.smtp)) return allowed.length;
  const voice = await readMailVoice(deps.db);
  const emails = await deps.db
    .selectFrom("users")
    .select(["id", "email"])
    .where("id", "in", recipients)
    .where("notifyByEmail", "=", true)
    .execute();
  for (const recipient of emails) {
    const first = allowed.find((item) => item.userId === recipient.id);
    const table = first?.tableId ? byId.get(first.tableId) : undefined;
    if (!first || !table) continue;
    const link = `${deps.webOrigin}/b/${table.baseId}/t/${table.id}${first.rowId ? `?row=${encodeURIComponent(first.rowId)}` : ""}`;
    await sendMail(deps.smtp, voice, {
      to: recipient.email,
      subject: notificationMailSubject(voice, first.kind, table.name),
      text: notificationMailBody(voice, first.kind, table.name, link),
    }).catch((error: unknown) => deps.log(error, "notification email failed"));
  }
  return allowed.length;
}

/** Recent notifications, without those about tables the user can no longer read. */
export async function listNotifications(
  db: Database,
  userId: string,
  options: { limit: number; unreadOnly: boolean },
) {
  let query = db
    .selectFrom("notifications as n")
    .leftJoin("users as actor", "actor.id", "n.actorId")
    .leftJoin("dataTables as t", "t.id", "n.tableId")
    .select([
      "n.id",
      "n.kind",
      "n.tableId",
      "n.rowId",
      "n.commentId",
      "n.data",
      "n.createdAt",
      "n.readAt",
      "actor.displayName as actorName",
      "t.name as tableName",
      "t.baseId",
    ])
    .where("n.userId", "=", userId);
  if (options.unreadOnly) query = query.where("n.readAt", "is", null);
  const rows = await query
    .orderBy("n.createdAt", "desc")
    .limit(options.limit)
    .execute();
  const bindings = await db
    .selectFrom("roleBindings")
    .select(["role", "scope", "scopeId"])
    .where("userId", "=", userId)
    .execute();
  return rows
    .filter(
      (row) =>
        !row.tableId ||
        roleAllows(
          effectiveTableRole(bindings, row.tableId, row.baseId ?? undefined),
          "read",
        ),
    )
    .map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      read: row.readAt !== null,
      readAt: undefined,
    }));
}

export async function unreadCount(
  db: Database,
  userId: string,
): Promise<number> {
  const row = await db
    .selectFrom("notifications")
    .select(sqlTag<number>`count(*)::int`.as("count"))
    .where("userId", "=", userId)
    .where("readAt", "is", null)
    .executeTakeFirst();
  return row?.count ?? 0;
}

/** Marks some, or with no ids all, of the user's notifications as read. */
export async function markRead(
  db: Database,
  userId: string,
  ids?: readonly string[],
): Promise<void> {
  if (ids?.length === 0) return;
  let query = db
    .updateTable("notifications")
    .set({ readAt: new Date() })
    .where("userId", "=", userId)
    .where("readAt", "is", null);
  if (ids) query = query.where("id", "in", [...ids]);
  await query.execute();
}

/** Read notifications go after 90 days, unread ones after 180. */
export async function purgeNotifications(db: Database): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  await db
    .deleteFrom("notifications")
    .where((eb) =>
      eb.or([
        eb("readAt", "<", new Date(Date.now() - READ_RETENTION_DAYS * day)),
        eb(
          "createdAt",
          "<",
          new Date(Date.now() - UNREAD_RETENTION_DAYS * day),
        ),
      ]),
    )
    .execute();
}

/** Ids added to a people list: `after` minus `before`. */
export function addedPeople(before: unknown, after: unknown): string[] {
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const old = new Set(list(before));
  return [...new Set(list(after))].filter((id) => !old.has(id));
}

/**
 * Whether a user field tells people newly put in it. Omitted / true keeps
 * today's behaviour; only an explicit `notify: false` turns it off.
 */
export function assignmentNotifies(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return true;
  }
  return (config as { notify?: unknown }).notify !== false;
}

/**
 * Notifies people newly put in a user field. The event's audit entry
 * tells what the field held before and after the change.
 */
export async function handleAssignments(
  deps: NotifyDeps,
  event: RowEvent,
): Promise<void> {
  if (!event.rowId || (event.event !== "insert" && event.event !== "update"))
    return;
  const userColumns = await deps.db
    .selectFrom("dataColumns")
    .select(["name", "label", "fieldType", "config"])
    .where("tableId", "=", event.tableId)
    .where("fieldType", "=", "user")
    .where(liveColumn())
    .execute();
  const watched = userColumns.filter((column) => {
    if (!assignmentNotifies(column.config)) return false;
    return (
      event.event === "insert" ||
      !event.columns ||
      event.columns.includes(column.name)
    );
  });
  if (watched.length === 0) return;
  let entry = deps.db
    .selectFrom("auditEvents")
    .select(["userId", "oldValue", "newValue"])
    .where("tableId", "=", event.tableId)
    .where("recordId", "=", event.rowId)
    .where("action", "in", ["insert", "update"]);
  // The entry the event comes from; the latest one for older events.
  if (event.auditId) entry = entry.where("id", "=", event.auditId);
  const last = await entry
    .orderBy("occurredAt", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!last) return;
  const before = (last.oldValue ?? {}) as Record<string, unknown>;
  const after = (last.newValue ?? {}) as Record<string, unknown>;
  const items: NotificationInput[] = watched.flatMap((column) =>
    addedPeople(before[column.name], after[column.name]).map((userId) => ({
      userId,
      kind: "assigned" as const,
      actorId: event.actorId ?? last.userId,
      tableId: event.tableId,
      rowId: event.rowId,
      data: { column: column.label },
    })),
  );
  await notify(deps, items);
}

/**
 * Notifications for a new or edited comment: people newly mentioned, and
 * the author of the comment it answers.
 */
export function commentNotifications(input: {
  tableId: string;
  rowId: string;
  commentId: string;
  authorId: string;
  mentioned: readonly string[];
  alreadyMentioned?: readonly string[];
  parentAuthorId?: string | null;
}): NotificationInput[] {
  const fresh = input.mentioned.filter(
    (id) => !input.alreadyMentioned?.includes(id),
  );
  const items: NotificationInput[] = fresh.map((userId) => ({
    userId,
    kind: "mention",
    actorId: input.authorId,
    tableId: input.tableId,
    rowId: input.rowId,
    commentId: input.commentId,
  }));
  if (input.parentAuthorId && !fresh.includes(input.parentAuthorId)) {
    items.push({
      userId: input.parentAuthorId,
      kind: "reply",
      actorId: input.authorId,
      tableId: input.tableId,
      rowId: input.rowId,
      commentId: input.commentId,
    });
  }
  return items;
}
