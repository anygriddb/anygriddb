/**
 * The token the first account of an instance is made with (ADR 0080).
 * That account administers the instance, so whoever reaches the sign-up
 * page first must also hold a token only the operator can ask for:
 * `anygriddb install-token`, run where the instance runs. The token is
 * printed to that terminal and nowhere else, never to the log; only its
 * hash is kept. It works once, for an hour.
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError, ceilingOf } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { hasAccounts } from "../admin.js";
import { recordAuthEvent } from "./auth-events.js";

/** How long a token works once made. */
export const INSTALL_TOKEN_TTL_MS = ceilingOf("protocol.install_token_ms");

function hashInstallToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Makes the token of an instance that has no account yet, in place of any
 * made before and not used; none for an instance that has one.
 */
export async function mintInstallToken(
  db: Database,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date } | null> {
  if (await hasAccounts(db)) return null;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INSTALL_TOKEN_TTL_MS);
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("installationTokens")
      .where("usedAt", "is", null)
      .execute();
    await tx
      .insertInto("installationTokens")
      .values({ tokenHash: hashInstallToken(token), expiresAt })
      .execute();
    await recordAuthEvent(tx, {
      action: "install_token_issued",
      method: "command",
    });
  });
  return { token, expiresAt };
}

/**
 * Takes the token the first account is made with: it must be the one in
 * force, not yet used, and within its hour. Used at once, so two
 * sign-ups cannot share it.
 */
export async function useInstallToken(
  db: Database,
  token: string | undefined,
  now: Date = new Date(),
): Promise<void> {
  const given = token?.trim();
  if (!given) throw new AppError("install_token_required");
  const used = await db
    .updateTable("installationTokens")
    .set({ usedAt: now })
    .where("tokenHash", "=", hashInstallToken(given))
    .where("usedAt", "is", null)
    .where("expiresAt", ">", now)
    .returning("id")
    .executeTakeFirst();
  // One answer for a token that is wrong, used, or too old: which of the
  // three it is tells a stranger something, and the operator nothing new.
  if (!used) throw new AppError("install_token_invalid");
  await recordAuthEvent(db, {
    action: "install_token_used",
    method: "signup",
  });
}
