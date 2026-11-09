/**
 * The mails that keep a person told about their account (ADR 0043): a
 * lock, a changed password, removed second factors, and a reset link.
 * Without email set up, nothing is sent. A failure is logged, never
 * thrown: the action it reports already happened.
 */
import type { Database } from "@anygriddb/db";
import { sendMail, smtpReady, type SmtpConfig } from "../mail.js";
import {
  resetMailBody,
  resetMailSubject,
  resolveLocale,
  securityMailBody,
  securityMailSubject,
  type SecurityNotice,
} from "../mail-i18n.js";
import { readSettings } from "../settings.js";

export type SecurityMailDeps = {
  db: Database;
  env: SmtpConfig & { PUBLIC_URL: string };
  log: { error: (object: object, message: string) => void };
};

async function recipient(
  deps: SecurityMailDeps,
  userId: string,
): Promise<{ to: string; locale: "en" | "fr" } | null> {
  if (!smtpReady(deps.env)) return null;
  const [user, settings] = await Promise.all([
    deps.db
      .selectFrom("users")
      .select("email")
      .where("id", "=", userId)
      .executeTakeFirst(),
    readSettings(deps.db),
  ]);
  if (!user) return null;
  return {
    to: user.email,
    locale: resolveLocale(null, settings.defaultLocale),
  };
}

/** Tells the person what happened to their account. */
export async function sendSecurityNotice(
  deps: SecurityMailDeps,
  userId: string,
  notice: SecurityNotice,
): Promise<boolean> {
  try {
    const to = await recipient(deps, userId);
    if (!to) return false;
    await sendMail(deps.env, {
      to: to.to,
      subject: securityMailSubject(to.locale, notice),
      text: securityMailBody(to.locale, notice),
    });
    return true;
  } catch (error) {
    deps.log.error({ err: error, notice: notice.kind }, "security mail failed");
    return false;
  }
}

/**
 * Sends a reset link to the account's own address and returns it, or null
 * without email set up. A failed send throws: the caller decides.
 */
export async function sendResetLink(
  deps: SecurityMailDeps,
  userId: string,
  input: { token: string; expiresAt: Date; byAdmin: boolean },
): Promise<string | null> {
  const to = await recipient(deps, userId);
  if (!to) return null;
  await sendMail(deps.env, {
    to: to.to,
    subject: resetMailSubject(to.locale),
    text: resetMailBody(to.locale, {
      link: resetLinkUrl(deps.env.PUBLIC_URL, input.token),
      expiresAt: input.expiresAt,
      byAdmin: input.byAdmin,
    }),
  });
  return to.to;
}

export function resetLinkUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/reset/${token}`;
}
