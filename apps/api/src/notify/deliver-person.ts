/**
 * Delivers person notifications once preferences and authorization are
 * known (ADR 0126): bell, immediate mail, or digest queue. Mail still
 * goes through sendMail and the instance relay.
 */
import {
  personEvent,
  type PersonChannel,
  type PersonEvent,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { KeyRing } from "../auth/key-ring.js";
import { notificationMailBody, notificationMailSubject } from "../mail-i18n.js";
import { sendMail, smtpReady, type SmtpConfig } from "../mail.js";
import type { Publisher } from "../realtime/bus.js";
import { gridChannel } from "../realtime/channels.js";
import { readMailVoice } from "../settings.js";
import { channelsForMany, mutedKeys } from "./person-preferences.js";
import { unsubscribeUrl } from "./unsubscribe.js";

/** Bell kinds that also live in the person-event catalogue. */
export type BellKind =
  | "mention"
  | "reply"
  | "assigned"
  | "automation"
  | "webhook_disabled"
  | "row_changed"
  | "role_given"
  | "owner_named"
  | "account_locked"
  | "admin_access"
  | "acting_as";

export type PersonNotice = {
  userId: string;
  event: PersonEvent;
  /** When set, a bell row is written for in-app channel. */
  bellKind?: BellKind;
  actorId?: string | null;
  tableId?: string | null;
  baseId?: string | null;
  rowId?: string | null;
  commentId?: string | null;
  data?: Record<string, string>;
  /** Link the immediate mail opens; digests use a settings page. */
  link?: string;
  /** Subject/body for mails that are not a table notification. */
  mail?: { subject: string; text: string };
};

export type DeliverDeps = {
  db: Database;
  bus: Publisher;
  smtp: SmtpConfig;
  webOrigin: string;
  log: (error: unknown, message: string) => void;
  keys?: KeyRing;
};

/**
 * Applies preferences, mutes, then delivers. Callers that deal with a
 * table must already have dropped people who cannot read it.
 */
export async function deliverPersonNotices(
  deps: DeliverDeps,
  notices: readonly PersonNotice[],
): Promise<number> {
  if (notices.length === 0) return 0;
  const byEvent = new Map<PersonEvent, PersonNotice[]>();
  for (const notice of notices) {
    const list = byEvent.get(notice.event) ?? [];
    list.push(notice);
    byEvent.set(notice.event, list);
  }
  const accepted: Array<PersonNotice & { channels: PersonChannel[] }> = [];
  const tables = [
    ...new Map(
      notices
        .filter((notice) => notice.tableId && notice.baseId)
        .map((notice) => [
          notice.tableId as string,
          { id: notice.tableId as string, baseId: notice.baseId as string },
        ]),
    ).values(),
  ];
  const userIds = [...new Set(notices.map((notice) => notice.userId))];
  const muted = await mutedKeys(deps.db, userIds, tables);

  for (const [event, group] of byEvent) {
    const definition = personEvent(event);
    const channels = await channelsForMany(
      deps.db,
      group.map((notice) => notice.userId),
      event,
    );
    for (const notice of group) {
      if (definition.scoped && notice.tableId) {
        const key = `${notice.userId}:t:${notice.tableId}`;
        const baseKey = notice.baseId
          ? `${notice.userId}:b:${notice.baseId}`
          : null;
        if (muted.has(key) || (baseKey && muted.has(baseKey))) continue;
      }
      const chosen = channels.get(notice.userId) ?? [];
      if (chosen.length === 0) continue;
      accepted.push({ ...notice, channels: chosen });
    }
  }
  if (accepted.length === 0) return 0;

  const bell = accepted.filter(
    (notice) =>
      notice.channels.includes("in_app") && notice.bellKind !== undefined,
  );
  if (bell.length > 0) {
    await deps.db
      .insertInto("notifications")
      .values(
        bell.map((notice) => ({
          userId: notice.userId,
          kind: notice.bellKind as BellKind,
          actorId: notice.actorId ?? null,
          tableId: notice.tableId ?? null,
          rowId: notice.rowId ?? null,
          commentId: notice.commentId ?? null,
          data: notice.data ?? null,
        })),
      )
      .execute();
    for (const userId of new Set(bell.map((notice) => notice.userId))) {
      try {
        await deps.bus.publish(
          gridChannel(userId),
          JSON.stringify({ type: "notification", channel: userId }),
        );
      } catch (error) {
        deps.log(error, "notification publish failed");
      }
    }
  }

  const digest = accepted.flatMap((notice) => {
    const rows: Array<{
      userId: string;
      event: PersonEvent;
      period: "daily" | "weekly";
      tableId: string | null;
      rowId: string | null;
      payload: Record<string, string> | null;
    }> = [];
    if (notice.channels.includes("email_daily")) {
      rows.push({
        userId: notice.userId,
        event: notice.event,
        period: "daily",
        tableId: notice.tableId ?? null,
        rowId: notice.rowId ?? null,
        payload: notice.data ?? null,
      });
    }
    if (notice.channels.includes("email_weekly")) {
      rows.push({
        userId: notice.userId,
        event: notice.event,
        period: "weekly",
        tableId: notice.tableId ?? null,
        rowId: notice.rowId ?? null,
        payload: notice.data ?? null,
      });
    }
    return rows;
  });
  if (digest.length > 0) {
    await deps.db
      .insertInto("notificationDigestItems")
      .values(digest)
      .execute();
  }

  const immediate = accepted.filter((notice) =>
    notice.channels.includes("email_immediate"),
  );
  if (immediate.length === 0 || !smtpReady(deps.smtp)) return accepted.length;

  const voice = await readMailVoice(deps.db);
  const emails = await deps.db
    .selectFrom("users")
    .select(["id", "email"])
    .where("id", "in", [...new Set(immediate.map((notice) => notice.userId))])
    .execute();
  const emailOf = new Map(emails.map((row) => [row.id, row.email]));

  for (const notice of immediate) {
    const to = emailOf.get(notice.userId);
    if (!to) continue;
    const unsub =
      deps.keys &&
      unsubscribeUrl(deps.webOrigin, deps.keys, {
        userId: notice.userId,
        event: notice.event,
        channel: "email_immediate",
      });
    if (notice.mail) {
      const text = unsub
        ? `${notice.mail.text}\n\n${unsubscribeLine(voice.locale, unsub)}`
        : notice.mail.text;
      await sendMail(deps.smtp, voice, {
        to,
        subject: notice.mail.subject,
        text,
      }).catch((error: unknown) =>
        deps.log(error, "notification email failed"),
      );
      continue;
    }
    if (!notice.link) continue;
    const tableName = notice.data?.table ?? notice.data?.base ?? "—";
    const kind = (notice.bellKind ?? notice.event) as Parameters<
      typeof notificationMailSubject
    >[1];
    const subject = notificationMailSubject(voice, kind, tableName);
    const text = notificationMailBody(
      voice,
      kind,
      tableName,
      notice.link,
      unsub ?? undefined,
    );
    await sendMail(deps.smtp, voice, { to, subject, text }).catch(
      (error: unknown) => deps.log(error, "notification email failed"),
    );
  }
  return accepted.length;
}

function unsubscribeLine(locale: "en" | "fr", url: string): string {
  return locale === "fr"
    ? `Pour ne plus recevoir ce type de message par e-mail immédiat : ${url}`
    : `Stop immediate email for this kind of notice: ${url}`;
}
