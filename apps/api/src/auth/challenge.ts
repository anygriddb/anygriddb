import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { hashSessionToken, isSessionToken } from "./session.js";

export const MFA_COOKIE = "__Host-ag_mfa";
const MFA_TTL_MS = 5 * 60 * 1000;
export const MFA_ATTEMPT_LIMIT = 5;

export async function createLoginChallenge(
  db: Database,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + MFA_TTL_MS);
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("loginChallenges")
      .where("userId", "=", userId)
      .execute();
    await tx
      .insertInto("loginChallenges")
      .values({ userId, tokenHash: hashSessionToken(token), expiresAt })
      .execute();
  });
  return { token, expiresAt };
}

export async function findLoginChallenge(
  db: Database,
  token: string | undefined,
): Promise<{ id: string; userId: string; attempts: number } | null> {
  if (!isSessionToken(token)) {
    return null;
  }
  const challenge = await db
    .selectFrom("loginChallenges")
    .select(["id", "userId", "attempts"])
    .where("tokenHash", "=", hashSessionToken(token))
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  return challenge ?? null;
}

/**
 * One more wrong code for this sign-in. Counted in the database, in one
 * statement, so codes tried together are each counted; the sign-in that
 * used up its tries is gone.
 */
export async function failLoginChallenge(
  db: Database,
  id: string,
): Promise<void> {
  const counted = await db
    .updateTable("loginChallenges")
    .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
    .where("id", "=", id)
    .returning("attempts")
    .executeTakeFirst();
  if (counted && counted.attempts >= MFA_ATTEMPT_LIMIT) {
    await db.deleteFrom("loginChallenges").where("id", "=", id).execute();
  }
}

export async function deleteLoginChallenge(
  db: Database,
  id: string,
): Promise<void> {
  await db.deleteFrom("loginChallenges").where("id", "=", id).execute();
}
