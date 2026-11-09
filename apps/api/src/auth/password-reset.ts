/**
 * Changing and resetting passwords (ADR 0043). A reset link sets a new
 * password once: the person asks for it by email, when the instance
 * allows it, or an administrator sends it. Only the link's hash is kept.
 * A new password ends the account's sessions and its lock; its second
 * factors stay, so a reset alone never opens an account that has them.
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError, type InstanceSettings } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { hashPassword } from "./argon2.js";
import { clearFailures } from "./lockout.js";

/** Asked by the person: an hour. Sent by an administrator: a day. */
export const SELF_RESET_TTL_MS = 60 * 60 * 1000;
export const ADMIN_RESET_TTL_MS = 24 * 60 * 60 * 1000;

const RESET_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The policy's minimum length; the schemas already hold 12 to 128. */
export function assertPasswordPolicy(
  password: string,
  policy: Pick<InstanceSettings, "passwordMinLength">,
): void {
  if (password.length < policy.passwordMinLength) {
    throw new AppError("password_too_short", String(policy.passwordMinLength));
  }
}

/** Whether the account has a password: one that signs in only by SSO has none. */
export async function hasPassword(
  db: Database,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("passwordHashes")
    .select("userId")
    .where("userId", "=", userId)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * A new link for an account, replacing any other it had. An account
 * without a password signs in through its identity provider: no link.
 */
export async function createResetLink(
  db: Database,
  input: { userId: string; createdBy: string | null; ttlMs: number },
): Promise<{ token: string; expiresAt: Date }> {
  if (!(await hasPassword(db, input.userId))) {
    throw new AppError("sso_account");
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + input.ttlMs);
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("passwordResets")
      .where("userId", "=", input.userId)
      .where("usedAt", "is", null)
      .execute();
    await tx
      .insertInto("passwordResets")
      .values({
        userId: input.userId,
        tokenHash: hashResetToken(token),
        createdBy: input.createdBy,
        expiresAt,
      })
      .execute();
  });
  return { token, expiresAt };
}

/** Whether a link still works: unused, unexpired, for an enabled account. */
export async function findResetLink(
  db: Database,
  token: string,
): Promise<{ id: string; userId: string; byAdmin: boolean } | null> {
  if (!RESET_TOKEN.test(token)) return null;
  const row = await db
    .selectFrom("passwordResets as r")
    .innerJoin("users as u", "u.id", "r.userId")
    .select(["r.id", "r.userId", "r.createdBy"])
    .where("r.tokenHash", "=", hashResetToken(token))
    .where("r.usedAt", "is", null)
    .where("r.expiresAt", ">", new Date())
    .where("u.disabledAt", "is", null)
    .executeTakeFirst();
  return row
    ? { id: row.id, userId: row.userId, byAdmin: row.createdBy !== null }
    : null;
}

/**
 * Sets the new password a link allows, once: the link is spent first, so
 * two tabs cannot both use it. Every session and sign-in step of the
 * account ends, and so does its lock.
 */
export async function resetPassword(
  db: Database,
  token: string,
  password: string,
  policy: Pick<InstanceSettings, "passwordMinLength">,
): Promise<{ userId: string; byAdmin: boolean }> {
  const link = await findResetLink(db, token);
  if (!link) throw new AppError("invalid_reset_link");
  assertPasswordPolicy(password, policy);
  const hash = await hashPassword(password);
  await db.transaction().execute(async (tx) => {
    const spent = await tx
      .updateTable("passwordResets")
      .set({ usedAt: new Date() })
      .where("id", "=", link.id)
      .where("usedAt", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!spent) throw new AppError("invalid_reset_link");
    const updated = await tx
      .updateTable("passwordHashes")
      .set({ hash, updatedAt: new Date() })
      .where("userId", "=", link.userId)
      .returning("userId")
      .executeTakeFirst();
    if (!updated) throw new AppError("sso_account");
    await tx.deleteFrom("sessions").where("userId", "=", link.userId).execute();
    await tx
      .deleteFrom("loginChallenges")
      .where("userId", "=", link.userId)
      .execute();
  });
  await clearFailures(db, link.userId);
  return { userId: link.userId, byAdmin: link.byAdmin };
}

/**
 * The person changes their own password: every other session of theirs
 * ends, and so does any link sent to reset it.
 */
export async function changePassword(
  db: Database,
  input: { userId: string; password: string; keepSessionHash?: string },
): Promise<void> {
  const hash = await hashPassword(input.password);
  await db.transaction().execute(async (tx) => {
    const updated = await tx
      .updateTable("passwordHashes")
      .set({ hash, updatedAt: new Date() })
      .where("userId", "=", input.userId)
      .returning("userId")
      .executeTakeFirst();
    if (!updated) throw new AppError("sso_account");
    await tx
      .deleteFrom("sessions")
      .where("userId", "=", input.userId)
      .$if(input.keepSessionHash !== undefined, (query) =>
        query.where("tokenHash", "!=", input.keepSessionHash ?? ""),
      )
      .execute();
    await tx
      .deleteFrom("passwordResets")
      .where("userId", "=", input.userId)
      .where("usedAt", "is", null)
      .execute();
  });
}

/** Spent and expired links, kept a week for the record, then deleted. */
export async function purgeResetLinks(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  const deleted = await db
    .deleteFrom("passwordResets")
    .where("expiresAt", "<", cutoff)
    .returning("id")
    .execute();
  return deleted.length;
}
