/**
 * Telling administrators when an account locks (ADR 0044): in the app's
 * bell, which needs no email, and by email when it is set up. Past ten
 * locks within an hour, one last alert says so and the rest wait in the
 * sign-in trail: a guessing run over many accounts must not flood anyone.
 */
import { alertRecipients } from "../alerts.js";
import type { KeyRing } from "./key-ring.js";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { resolveSmtp } from "../integrations/smtp.js";
import { sendMail, smtpReady, type SmtpConfig } from "../mail.js";
import {
  lockAlertBody,
  lockAlertSubject,
  mailVoice,
  type LockAlert,
} from "../mail-i18n.js";
import type { Publisher } from "../realtime/bus.js";
import { gridChannel } from "../realtime/channels.js";
import { readSettings } from "../settings.js";

export const LOCK_ALERTS_PER_HOUR = 10;

export type LockAlertDeps = {
  db: Database;
  bus: Publisher;
  env: SmtpConfig & { PUBLIC_URL: string; AUTH_ENCRYPTION_KEY: KeyRing };
  log: { error: (object: object, message: string) => void };
};

/**
 * Alerts every other enabled administrator that `userId` just locked; the
 * lock is already in the trail. Returns how many were told.
 */
export async function alertLock(
  deps: LockAlertDeps,
  input: { userId: string; failures: number; until: Date | null },
): Promise<number> {
  const settings = await readSettings(deps.db);
  if (!settings.lockAlerts) return 0;
  const recent = await deps.db
    .selectFrom("authEvents")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("action", "=", "account_locked")
    .where("occurredAt", ">", sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirst();
  const count = recent?.count ?? 0;
  if (count > LOCK_ALERTS_PER_HOUR + 1) return 0;
  const account = await deps.db
    .selectFrom("users")
    .select(["displayName", "email"])
    .where("id", "=", input.userId)
    .executeTakeFirst();
  if (!account) return 0;
  const alert: LockAlert =
    count > LOCK_ALERTS_PER_HOUR
      ? { many: true }
      : {
          many: false,
          name: account.displayName,
          email: account.email,
          failures: input.failures,
          until: input.until,
        };
  // Every other active administrator, but those who asked not to be
  // told of locks (ROADMAP #48).
  const admins = await alertRecipients(deps.db, "account_locked", input.userId);
  if (admins.length === 0) return 0;
  const data: Record<string, string> = alert.many
    ? { many: "1" }
    : { name: alert.name, userId: input.userId };
  await deps.db
    .insertInto("notifications")
    .values(
      admins.map((admin) => ({
        userId: admin.id,
        kind: "account_locked" as const,
        data,
      })),
    )
    .execute();
  for (const admin of admins) {
    try {
      await deps.bus.publish(
        gridChannel(admin.id),
        JSON.stringify({ type: "notification", channel: admin.id }),
      );
    } catch (error) {
      deps.log.error({ err: error }, "notification publish failed");
    }
  }
  const { config: smtp } = await resolveSmtp(deps.db, deps.env);
  if (smtpReady(smtp)) {
    const voice = mailVoice(settings);
    const adminUrl = `${deps.env.PUBLIC_URL.replace(/\/+$/, "")}/admin`;
    for (const admin of admins) {
      await sendMail(smtp, voice, {
        to: admin.email,
        subject: lockAlertSubject(voice, alert),
        text: lockAlertBody(voice, alert, adminUrl),
      }).catch((error: unknown) => {
        deps.log.error({ err: error }, "lock alert mail failed");
      });
    }
  }
  return admins.length;
}
