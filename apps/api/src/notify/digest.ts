/**
 * Sends queued daily and weekly digests through the instance mail relay
 * (ADR 0126). One mail per person per period, listing what waited.
 */
import { trimEndRun } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { KeyRing } from "../auth/key-ring.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { sendMail, smtpReady, type SmtpConfig } from "../mail.js";
import { readMailVoice } from "../settings.js";
import { unsubscribeUrl } from "./unsubscribe.js";

export type DigestDeps = {
  db: Database;
  env: SmtpConfig & { PUBLIC_URL: string; AUTH_ENCRYPTION_KEY: KeyRing };
  log: (error: unknown, message: string) => void;
};

export async function sendDigests(
  deps: DigestDeps,
  period: "daily" | "weekly",
): Promise<number> {
  const { config: smtp } = await resolveSmtp(deps.db, deps.env);
  if (!smtpReady(smtp)) return 0;
  const items = await deps.db
    .selectFrom("notificationDigestItems")
    .select(["id", "userId", "event", "tableId", "payload", "createdAt"])
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
    .execute();
  const voice = await readMailVoice(deps.db);
  const settingsUrl = `${trimEndRun(deps.env.PUBLIC_URL, "/")}/settings/account`;
  let sent = 0;
  for (const user of users) {
    const list = byUser.get(user.id) ?? [];
    if (list.length === 0) continue;
    const lines = list.map((item) => {
      const when = item.createdAt.toISOString();
      const label = item.event.replaceAll("_", " ");
      return `- ${when}: ${label}`;
    });
    const first = list[0];
    if (!first) continue;
    const unsub = unsubscribeUrl(
      deps.env.PUBLIC_URL,
      deps.env.AUTH_ENCRYPTION_KEY,
      {
        userId: user.id,
        event: first.event as Parameters<typeof unsubscribeUrl>[2]["event"],
        channel: period === "daily" ? "email_daily" : "email_weekly",
      },
    );
    const subject =
      voice.locale === "fr"
        ? `${voice.name}\u00a0: résumé ${period === "daily" ? "quotidien" : "hebdomadaire"}`
        : `${voice.name}: ${period} notification digest`;
    const intro =
      voice.locale === "fr"
        ? `Voici les notifications en attente (${String(list.length)}) :`
        : `Here are the notifications that waited (${String(list.length)}):`;
    const stop =
      voice.locale === "fr"
        ? `Pour arrêter ce résumé : ${unsub}`
        : `Stop this digest: ${unsub}`;
    try {
      await sendMail(smtp, voice, {
        to: user.email,
        subject,
        text: `${intro}\n\n${lines.join("\n")}\n\n${settingsUrl}\n\n${stop}`,
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
