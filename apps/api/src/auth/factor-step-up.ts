import type { KeyRing } from "./key-ring.js";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { verifyPassword } from "./argon2.js";
import { factorMethods } from "./access.js";
import { consumeTotpCode } from "./totp.js";

/**
 * A session may enroll its first authenticator app, and a code by email
 * when the account has no second factor yet. Replacing that app,
 * registering a passkey, adding a code by email beside another factor, or
 * turning it off needs the current password or a code from the
 * authenticator already on the account: a code by email beside an
 * authenticator is one more way in, which a borrowed session must not
 * open. An account with neither (single sign-on, no authenticator yet)
 * keeps the session it just opened.
 */
export async function assertMayChangeFactor(
  db: Database,
  key: KeyRing,
  userId: string,
  kind: "totp" | "passkey" | "email",
  proof: { password?: string; factorCode?: string },
): Promise<void> {
  const methods = await factorMethods(db, userId);
  if (kind === "totp" && !methods.includes("totp")) return;
  if (kind === "email" && methods.length === 0) return;

  const stored = await db
    .selectFrom("passwordHashes")
    .select("hash")
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (
    stored &&
    proof.password !== undefined &&
    (await verifyPassword(stored.hash, proof.password))
  ) {
    return;
  }
  if (
    methods.includes("totp") &&
    proof.factorCode !== undefined &&
    (await consumeTotpCode(db, userId, proof.factorCode, key))
  ) {
    return;
  }
  if (!stored && !methods.includes("totp")) return;
  throw new AppError("invalid_credentials");
}
