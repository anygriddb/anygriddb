import { ceilingOf } from "@anygriddb/core";
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { hashSessionToken, isSessionToken, type SignOn } from "./session.js";

export const MFA_COOKIE = "__Host-ag_mfa";
const MFA_TTL_MS = ceilingOf("protocol.second_factor_ms");
export const MFA_ATTEMPT_LIMIT = ceilingOf("auth.second_factor_attempts");

export async function createLoginChallenge(
  db: Database,
  userId: string,
  /** The provider this sign-in came through; none for a password. */
  signOn?: SignOn | null,
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
      .values({
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt,
        signOn: signOn?.provider ?? null,
        signOnSid: signOn?.sidHash ?? null,
        mustEndAt: signOn?.mustEndAt ?? null,
        bindIssuer: signOn?.binding?.issuer ?? null,
        bindSubject: signOn?.binding?.subject ?? null,
      })
      .execute();
  });
  return { token, expiresAt };
}

export async function findLoginChallenge(
  db: Database,
  token: string | undefined,
): Promise<{
  id: string;
  userId: string;
  attempts: number;
  signOn: SignOn | null;
} | null> {
  if (!isSessionToken(token)) {
    return null;
  }
  const challenge = await db
    .selectFrom("loginChallenges")
    .select([
      "id",
      "userId",
      "attempts",
      "signOn",
      "signOnSid",
      "mustEndAt",
      "bindIssuer",
      "bindSubject",
    ])
    .where("tokenHash", "=", hashSessionToken(token))
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  if (!challenge) return null;
  const { signOn, signOnSid, mustEndAt, bindIssuer, bindSubject, ...rest } =
    challenge;
  return {
    ...rest,
    signOn:
      signOn === "oidc" || signOn === "saml"
        ? {
            provider: signOn,
            sidHash: signOnSid,
            mustEndAt,
            binding:
              bindIssuer !== null && bindSubject !== null
                ? { issuer: bindIssuer, subject: bindSubject }
                : null,
          }
        : null,
  };
}

/**
 * Drops the sign-ins waiting for a second step that began with a password,
 * for anyone but an administrator: under single sign-on only, none of them
 * may finish.
 */
export async function dropPasswordChallenges(db: Database): Promise<void> {
  await db
    .deleteFrom("loginChallenges")
    .where("signOn", "is", null)
    .where("userId", "in", (eb) =>
      eb.selectFrom("users").select("id").where("isAdmin", "=", false),
    )
    .execute();
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
