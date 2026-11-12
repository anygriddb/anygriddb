import type { Database } from "@anygriddb/db";

/**
 * What a sign-in leaves behind once its time is up: sessions nobody ended,
 * single sign-on attempts nobody finished, second-step and passkey
 * challenges nobody answered. Each is refused once expired wherever it is
 * read; the hourly purge deletes the rows, so that a table of secrets'
 * hashes does not grow with every sign-in the instance ever saw.
 */
export async function purgeExpiredSignIns(db: Database): Promise<{
  sessions: number;
  states: number;
  challenges: number;
}> {
  const now = new Date();
  const sessions = await db
    .deleteFrom("sessions")
    .where("expiresAt", "<", now)
    .returning("id")
    .execute();
  const states = await db
    .deleteFrom("oauthStates")
    .where("expiresAt", "<", now)
    .returning("id")
    .execute();
  const second = await db
    .deleteFrom("loginChallenges")
    .where("expiresAt", "<", now)
    .returning("id")
    .execute();
  const passkey = await db
    .deleteFrom("webauthnChallenges")
    .where("expiresAt", "<", now)
    .returning("id")
    .execute();
  return {
    sessions: sessions.length,
    states: states.length,
    challenges: second.length + passkey.length,
  };
}
