/**
 * Sends queued daily and weekly digests through the instance mail relay
 * (ADR 0123). One mail per person per period, listing what waited.
 */
import { trimEndRun } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { KeyRing } from "../auth/key-ring.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { moment, notificationSubject, type MailVoice } from "../mail-i18n.js";
import { sendMail, smtpReady, type SmtpConfig } from "../mail.js";
import type { NotificationKind } from "../notifications.js";
import { readMailVoice } from "../settings.js";
import { unsubscribeUrl } from "./unsubscribe.js";

/** The lines one digest lists; it counts the rest. */
export const DIGEST_LINES = 50;

/** What waits longer, mail off or an address gone, is no longer sent. */
const DIGEST_KEEP_DAYS = 30;

export type DigestDeps = {
  db: Database;
  env: SmtpConfig & { PUBLIC_URL: string; AUTH_ENCRYPTION_KEY: KeyRing };
  log: (error: unknown, message: string) => void;
};

type DigestItem = {
  event: string;
  payload: unknown;
  createdAt: Date;
};

const BELL_SUBJECTS: ReadonlySet<string> = new Set<NotificationKind>([
  "mention",
  "reply",
  "assigned",
  "automation",
  "webhook_disabled",
  "row_changed",
  "role_given",
  "owner_named",
  "account_locked",
  "admin_access",
  "acting_as",
]);

function text(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** One line of a digest: when, then what, in the instance's language. */
export function digestLine(voice: MailVoice, item: DigestItem): string {
  const what =
    text(item.payload, "subject") ??
    (BELL_SUBJECTS.has(item.event)
      ? notificationSubject(
          voice,
          item.event as NotificationKind,
          text(item.payload, "table") ?? text(item.payload, "base") ?? "—",
        )
      : item.event);
  return `- ${moment(voice.locale, item.createdAt)} — ${what}`;
}

/** The whole text of one person's digest. */
export function digestText(
  voice: MailVoice,
  period: "daily" | "weekly",
  items: readonly DigestItem[],
  settingsUrl: string,
  stopUrl: string,
): string {
  const shown = items.slice(0, DIGEST_LINES);
  const more = items.length - shown.length;
  const fr = voice.locale === "fr";
  const intro = fr
    ? `Ce qui vous attendait (${String(items.length)})\u00a0:`
    : `What waited for you (${String(items.length)}):`;
  const rest =
    more > 0
      ? fr
        ? [`… et ${String(more)} de plus.`]
        : [`… and ${String(more)} more.`]
      : [];
  const settings = fr
    ? `Vos préférences\u00a0: ${settingsUrl}`
    : `Your preferences: ${settingsUrl}`;
  const stop = fr
    ? `Ne plus recevoir ce résumé ${period === "daily" ? "quotidien" : "hebdomadaire"}\u00a0: ${stopUrl}`
    : `Stop this ${period} digest: ${stopUrl}`;
  return [
    intro,
    "",
    ...shown.map((item) => digestLine(voice, item)),
    ...rest,
    "",
    settings,
    stop,
  ].join("\n");
}

export async function sendDigests(
  deps: DigestDeps,
  period: "daily" | "weekly",
): Promise<number> {
  await deps.db
    .deleteFrom("notificationDigestItems")
    .where(
      "createdAt",
      "<",
      new Date(Date.now() - DIGEST_KEEP_DAYS * 86_400_000),
    )
    .execute();
  const { config: smtp } = await resolveSmtp(deps.db, deps.env);
  if (!smtpReady(smtp)) return 0;
  const items = await deps.db
    .selectFrom("notificationDigestItems")
    .select(["id", "userId", "event", "payload", "createdAt"])
    .where("period", "=", period)
    .orderBy("createdAt", "asc")
    .execute();
  if (items.length === 0) return 0;
  const byUser = new Map<string, typeof items>();
  for (const item of items) {
    const list = byUser.get(item.userId) ?? [];
    list.push(item);
    byUser.set(item.userId, list);
  }
  const users = await deps.db
    .selectFrom("users")
    .select(["id", "email"])
    .where("id", "in", [...byUser.keys()])
    .where("disabledAt", "is", null)
    .execute();
  const voice = await readMailVoice(deps.db);
  const origin = trimEndRun(deps.env.PUBLIC_URL, "/");
  const settingsUrl = `${origin}/settings/account`;
  const channel = period === "daily" ? "email_daily" : "email_weekly";
  const subject =
    voice.locale === "fr"
      ? `${voice.name}\u00a0: résumé ${period === "daily" ? "quotidien" : "hebdomadaire"}`
      : `${voice.name}: ${period} digest`;
  let sent = 0;
  for (const user of users) {
    const list = byUser.get(user.id) ?? [];
    if (list.length === 0) continue;
    // The digest's own link stops the digest, every kind of notice in it.
    const stopUrl = unsubscribeUrl(origin, deps.env.AUTH_ENCRYPTION_KEY, {
      userId: user.id,
      event: null,
      channel,
    });
    try {
      await sendMail(smtp, voice, {
        to: user.email,
        subject,
        text: digestText(voice, period, list, settingsUrl, stopUrl),
      });
      sent += 1;
    } catch (error) {
      deps.log(error, "notification digest mail failed");
      continue;
    }
    await deps.db
      .deleteFrom("notificationDigestItems")
      .where(
        "id",
        "in",
        list.map((item) => item.id),
      )
      .execute();
  }
  return sent;
}
