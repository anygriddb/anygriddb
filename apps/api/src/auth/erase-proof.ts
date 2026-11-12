import type { Database } from "@anygriddb/db";
import { factorMethods } from "./access.js";
import { verifyPassword } from "./argon2.js";
import { consumeBackupCode } from "./backup-store.js";
import { hashSessionToken, isSessionToken } from "./session.js";
import { consumeTotpCode } from "./totp.js";

/** How old a sign-in may be to stand where nothing else can be asked. */
export const FRESH_SIGN_IN_MS = 10 * 60_000;

/**
 * What deleting one's own account found of its proof: `missing` when a
 * proof was left out (nothing was guessed), `wrong` when one was given
 * and is not the account's (it counts toward the lock), `stale` when the
 * sign-in is too old to stand for a proof.
 */
export type ErasureProof = "ok" | "missing" | "wrong" | "stale";

/** When the session of this cookie began: its sign-in, not its last use. */
export async function sessionStartedAt(
  db: Database,
  token: string | undefined,
): Promise<Date | null> {
  if (!isSessionToken(token)) return null;
  const row = await db
    .selectFrom("sessions")
    .select("createdAt")
    .where("tokenHash", "=", hashSessionToken(token))
    .where("expiresAt", ">", new Date())
    .executeTakeFirst();
  return row?.createdAt ?? null;
}

/**
 * Deleting one's own account asks what a sensitive action asks:
 * the password, when the account has one; a code from its authenticator
 * (or a backup code), when it has one; and a sign-in less than ten
 * minutes old where neither can be asked: an account that signs in
 * through its provider only, or whose second factor is a passkey, which
 * a sign-in alone checks.
 */
export async function proveOwnErasure(
  db: Database,
  key: Buffer,
  input: {
    userId: string;
    startedAt: Date | null;
    proof: { password?: string | undefined; factorCode?: string | undefined };
    now?: Date;
  },
): Promise<ErasureProof> {
  const { userId, proof } = input;
  const stored = await db
    .selectFrom("passwordHashes")
    .select("hash")
    .where("userId", "=", userId)
    .executeTakeFirst();
  const methods = await factorMethods(db, userId);
  const code = methods.includes("totp");
  if (stored && proof.password === undefined) return "missing";
  if (code && proof.factorCode === undefined) return "missing";

  // No password to ask, or a passkey for only factor: the sign-in itself.
  if (!stored || (methods.includes("webauthn") && !code)) {
    const age =
      input.startedAt === null
        ? Number.POSITIVE_INFINITY
        : (input.now ?? new Date()).getTime() - input.startedAt.getTime();
    if (age > FRESH_SIGN_IN_MS) return "stale";
  }

  if (stored && !(await verifyPassword(stored.hash, proof.password ?? ""))) {
    return "wrong";
  }
  if (code) {
    const given = proof.factorCode ?? "";
    const accepted =
      (await consumeTotpCode(db, userId, given, key)) ||
      (await consumeBackupCode(db, userId, given, key));
    if (!accepted) return "wrong";
  }
  return "ok";
}
