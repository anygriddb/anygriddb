/**
 * A new account's way in: a link that sets its first password, mailed to
 * its address where mail is set up, and handed to whoever made the
 * account where it is not. Administration's page and the administration
 * API both make accounts through here.
 */
import type { Database } from "@anygriddb/db";
import { resolveSmtp } from "../integrations/smtp.js";
import { smtpReady, smtpRefusal } from "../mail.js";
import { AppError } from "@anygriddb/core";
import { ACCOUNT_LINK_TTL_MS, createResetLink } from "./password-reset.js";
import {
  resetLinkUrl,
  type SecurityMailDeps,
  sendWelcome,
} from "./security-mail.js";

export type AccountWelcome =
  | { sent: true; to: string }
  | {
      sent: false;
      link: string;
      expiresAt: string;
      /** Why the mail did not go, where mail is set up. */
      reason?: ReturnType<typeof smtpRefusal>;
    };

export async function welcomeAccount(
  deps: SecurityMailDeps & { db: Database },
  userId: string,
  creator: { id: string; displayName: string },
): Promise<AccountWelcome> {
  const link = await createResetLink(deps.db, {
    userId,
    createdBy: creator.id,
    ttlMs: ACCOUNT_LINK_TTL_MS,
  });
  const handed = {
    sent: false as const,
    link: resetLinkUrl(deps.env.PUBLIC_URL, link.token),
    expiresAt: link.expiresAt.toISOString(),
  };
  if (!smtpReady((await resolveSmtp(deps.db, deps.env)).config)) return handed;
  // The account is made: a relay that does not answer leaves its link to
  // be handed, as an invitation's is, never an error with no link.
  let to: string | null;
  try {
    to = await sendWelcome(deps, userId, {
      ...link,
      creatorName: creator.displayName,
    });
  } catch (error) {
    deps.log.error({ err: error }, "welcome mail failed");
    return { ...handed, reason: smtpRefusal(error) };
  }
  if (!to) throw new AppError("smtp_not_configured");
  return { sent: true, to };
}
