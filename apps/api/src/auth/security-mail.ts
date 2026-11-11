/**
 * The mails that keep a person told about their account (ADR 0043): a
 * lock, a changed password, removed second factors, and a reset link.
 * Without email set up, nothing is sent. A failure is logged, never
 * thrown: the action it reports already happened.
 */
import type { Database } from "@anygriddb/db";
import { resolveSmtp } from "../integrations/smtp.js";
import { sendMail, smtpReady, type SmtpConfig } from "../mail.js";
import {
  accountExistsMailBody,
  accountExistsMailSubject,
  type MailLocale,
  resetMailBody,
  resetMailSubject,
  resolveLocale,
  signupMailBody,
  signupMailSubject,
  securityMailBody,
  securityMailSubject,
  type SecurityNotice,
} from "../mail-i18n.js";
import { readSettings } from "../settings.js";
import { signupLinkUrl } from "./signup-requests.js";

export type SecurityMailDeps = {
  db: Database;
  env: SmtpConfig & { PUBLIC_URL: string; AUTH_ENCRYPTION_KEY: Buffer };
  log: { error: (object: object, message: string) => void };
};

async function recipient(
  deps: SecurityMailDeps,
  userId: string,
): Promise<{ to: string; locale: "en" | "fr"; smtp: SmtpConfig } | null> {
  const { config: smtp } = await resolveSmtp(deps.db, deps.env);
  if (!smtpReady(smtp)) return null;
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
    smtp,
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
    await sendMail(to.smtp, {
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
  await sendMail(to.smtp, {
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

/**
 * Mails what a sign-up calls for to the address it names, in the language
 * the page was in (ADR 0058): its link, or, for an address that has an
 * account, word of the attempt. Returns false without email set up; a
 * failed send throws.
 */
export async function sendSignupMail(
  deps: SecurityMailDeps,
  input: { to: string; locale: MailLocale } & (
    { kind: "link"; token: string; expiresAt: Date } | { kind: "exists" }
  ),
): Promise<boolean> {
  const { config: smtp } = await resolveSmtp(deps.db, deps.env);
  if (!smtpReady(smtp)) return false;
  const publicUrl = deps.env.PUBLIC_URL.replace(/\/+$/, "");
  await sendMail(
    smtp,
    input.kind === "link"
      ? {
          to: input.to,
          subject: signupMailSubject(input.locale),
          text: signupMailBody(input.locale, {
            link: signupLinkUrl(publicUrl, input.token),
            expiresAt: input.expiresAt,
          }),
        }
      : {
          to: input.to,
          subject: accountExistsMailSubject(input.locale),
          text: accountExistsMailBody(input.locale, {
            loginUrl: `${publicUrl}/login`,
          }),
        },
  );
  return true;
}
