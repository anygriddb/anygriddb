/**
 * Telling administrators when an account locks (ADR 0044): in the app's
 * bell, which needs no email, and by email when preferences allow it.
 * Past ten locks within an hour, one last alert says so and the rest wait
 * in the sign-in trail: a guessing run over many accounts must not flood
 * anyone.
 */
import { trimEndRun } from "@anygriddb/core";
import { alertRecipients } from "../alerts.js";
import type { KeyRing } from "./key-ring.js";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { resolveSmtp } from "../integrations/smtp.js";
import type { SmtpConfig } from "../mail.js";
import {
  lockAlertBody,
  lockAlertSubject,
  mailVoice,
  type LockAlert,
} from "../mail-i18n.js";
import { deliverPersonNotices } from "../notify/deliver-person.js";
import type { Publisher } from "../realtime/bus.js";
import { readSettings } from "../settings.js";

const LOCK_ALERTS_PER_HOUR = 10;

type LockAlertDeps = {
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
  // told of locks (ROADMAP #48 / alert_optouts). Person preferences then
  // decide channels (ADR 0126).
  const admins = await alertRecipients(deps.db, "account_locked", input.userId);
  if (admins.length === 0) return 0;
  const data: Record<string, string> = alert.many
    ? { many: "1" }
    : { name: alert.name, userId: input.userId };
  const { config: smtp } = await resolveSmtp(deps.db, deps.env);
  const voice = mailVoice(settings);
  const adminUrl = `${trimEndRun(deps.env.PUBLIC_URL, "/")}/admin`;
  return deliverPersonNotices(
    {
      db: deps.db,
      bus: deps.bus,
      smtp,
      webOrigin: deps.env.PUBLIC_URL,
      log: (error, message) => deps.log.error({ err: error }, message),
      keys: deps.env.AUTH_ENCRYPTION_KEY,
    },
    admins.map((admin) => ({
      userId: admin.id,
      event: "account_locked" as const,
      bellKind: "account_locked" as const,
      data,
      link: adminUrl,
      mail: {
        subject: lockAlertSubject(voice, alert),
        text: lockAlertBody(voice, alert, adminUrl),
      },
    })),
  );
}
