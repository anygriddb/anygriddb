/**
 * Operator mail (ADR 0052): an administrator queues a plain-text notice
 * to every active account or to chosen ids. Recipients are resolved at
 * enqueue time; the worker sends one message each and never logs an
 * address or the body.
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { recordAuthEvent } from "./auth/auth-events.js";
import { ERASED_USER_ID } from "./data/erasure.js";
import { resolveSmtp } from "./integrations/smtp.js";
import { sendMail, smtpReady, type SmtpConfig } from "./mail.js";
import { operatorMailText, resolveLocale } from "./mail-i18n.js";
import { addJob, TASKS } from "./queue/jobs.js";
import { readMailVoice, readSettings } from "./settings.js";
import type { Env } from "./env.js";

export const MAX_OPERATOR_MAIL_RECIPIENTS = 500;
const MAX_OPERATOR_MAIL_SUBJECT = 200;
const MAX_OPERATOR_MAIL_BODY = 5_000;
/** At most this many operator sends per rolling hour on the instance. */
export const MAX_OPERATOR_MAIL_PER_HOUR = 5;

export const operatorMailRecipientsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all_active") }),
  z.object({
    mode: z.literal("ids"),
    userIds: z.array(z.uuid()).min(1).max(MAX_OPERATOR_MAIL_RECIPIENTS),
  }),
]);

export const operatorMailInputSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1)
    .max(MAX_OPERATOR_MAIL_SUBJECT)
    .refine((value) => !/[\r\n]/.test(value), { message: "no newlines" }),
  body: z.string().trim().min(1).max(MAX_OPERATOR_MAIL_BODY),
  recipients: operatorMailRecipientsSchema,
});

type OperatorMailInput = z.infer<typeof operatorMailInputSchema>;
type OperatorMailRecipients = z.infer<typeof operatorMailRecipientsSchema>;

type OperatorRecipient = { id: string; email: string };

export const operatorMailPayloadSchema = z.object({
  actorId: z.uuid(),
  subject: z.string().min(1).max(MAX_OPERATOR_MAIL_SUBJECT),
  body: z.string().min(1).max(MAX_OPERATOR_MAIL_BODY),
  userIds: z.array(z.uuid()).min(1).max(MAX_OPERATOR_MAIL_RECIPIENTS),
  locale: z.enum(["en", "fr"]),
});

type OperatorMailPayload = z.infer<typeof operatorMailPayloadSchema>;

/** Active accounts, or the chosen ids that still exist (never the tombstone). */
export async function resolveOperatorRecipients(
  db: Database,
  recipients: OperatorMailRecipients,
): Promise<OperatorRecipient[]> {
  if (recipients.mode === "all_active") {
    const rows = await db
      .selectFrom("users")
      .select(["id", "email"])
      .where("id", "<>", ERASED_USER_ID)
      .where("disabledAt", "is", null)
      .orderBy("createdAt", "asc")
      .execute();
    if (rows.length > MAX_OPERATOR_MAIL_RECIPIENTS) {
      throw new AppError("too_many_recipients");
    }
    return rows;
  }
  const unique = [...new Set(recipients.userIds)];
  if (unique.length === 0) return [];
  const rows = await db
    .selectFrom("users")
    .select(["id", "email"])
    .where("id", "<>", ERASED_USER_ID)
    .where("id", "in", unique)
    .orderBy("createdAt", "asc")
    .execute();
  return rows;
}

/** Refuses a sixth send within the last hour. */
async function assertOperatorMailQuota(db: Database): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const row = await db
    .selectFrom("authEvents")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("action", "=", "operator_mail_sent")
    .where("occurredAt", ">=", since)
    .executeTakeFirst();
  const count = Number(row?.count ?? 0);
  if (count >= MAX_OPERATOR_MAIL_PER_HOUR) {
    throw new AppError("operator_mail_limited");
  }
}

type QueueOperatorMailDeps = {
  db: Database;
  env: Env;
  actorId: string;
  ip?: string | null;
};

/**
 * Checks SMTP and quota, freezes recipients, records the trail event, and
 * queues the worker task. Returns how many accounts will be mailed.
 */
export async function queueOperatorMail(
  deps: QueueOperatorMailDeps,
  input: OperatorMailInput,
): Promise<{ recipientCount: number }> {
  const { config: smtp } = await resolveSmtp(deps.db, deps.env);
  if (!smtpReady(smtp)) throw new AppError("smtp_not_configured");
  await assertOperatorMailQuota(deps.db);

  const people = await resolveOperatorRecipients(deps.db, input.recipients);
  if (people.length === 0) throw new AppError("no_recipients");
  if (people.length > MAX_OPERATOR_MAIL_RECIPIENTS) {
    throw new AppError("too_many_recipients");
  }

  const settings = await readSettings(deps.db);
  const locale = resolveLocale(null, settings.defaultLocale);
  const detail =
    input.recipients.mode === "all_active" ? "all_active" : "selected";
  const payload: OperatorMailPayload = {
    actorId: deps.actorId,
    subject: input.subject,
    body: input.body,
    userIds: people.map((person) => person.id),
    locale,
  };

  await deps.db.transaction().execute(async (tx) => {
    await recordAuthEvent(tx, {
      action: "operator_mail_sent",
      actorId: deps.actorId,
      method: "admin",
      detail,
      ip: deps.ip,
    });
    await addJob(tx, TASKS.operatorMail, payload, {
      maxAttempts: 3,
    });
  });

  return { recipientCount: people.length };
}

type DeliverOperatorMailDeps = {
  db: Database;
  smtp: SmtpConfig;
  log: (error: unknown, message: string) => void;
};

/** Sends one notice per account id still present; failures do not stop others. */
export async function deliverOperatorMail(
  deps: DeliverOperatorMailDeps,
  payload: OperatorMailPayload,
): Promise<{ sent: number; failed: number }> {
  if (!smtpReady(deps.smtp)) {
    throw new AppError("smtp_not_configured");
  }
  const people = await deps.db
    .selectFrom("users")
    .select(["id", "email"])
    .where("id", "<>", ERASED_USER_ID)
    .where("id", "in", payload.userIds)
    .execute();
  const voice = await readMailVoice(deps.db, payload.locale);
  const text = operatorMailText(voice, payload.body);
  let sent = 0;
  let failed = 0;
  for (const person of people) {
    try {
      await sendMail(deps.smtp, voice, {
        to: person.email,
        subject: payload.subject,
        text,
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      deps.log({ err: error, userId: person.id }, "operator mail failed");
    }
  }
  return { sent, failed };
}
