/**
 * A new account's way in: a link that sets its first password, mailed to
 * its address where mail is set up, and handed to whoever made the
 * account where it is not. Administration's page and the administration
 * API both make accounts through here.
 */
import type { Database } from "@anygriddb/db";
import { resolveSmtp } from "../integrations/smtp.js";
import { smtpReady } from "../mail.js";
import { AppError } from "@anygriddb/core";
import { ACCOUNT_LINK_TTL_MS, createResetLink } from "./password-reset.js";
import {
  resetLinkUrl,
  type SecurityMailDeps,
  sendWelcome,
} from "./security-mail.js";

export type AccountWelcome =
  { sent: true; to: string } | { sent: false; link: string; expiresAt: string };

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
  if (smtpReady((await resolveSmtp(deps.db, deps.env)).config)) {
    const to = await sendWelcome(deps, userId, {
      ...link,
      creatorName: creator.displayName,
    });
    if (!to) throw new AppError("smtp_not_configured");
    return { sent: true, to };
  }
  return {
    sent: false,
    link: resetLinkUrl(deps.env.PUBLIC_URL, link.token),
    expiresAt: link.expiresAt.toISOString(),
  };
}
