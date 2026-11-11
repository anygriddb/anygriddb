import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { verifyPassword } from "./argon2.js";
import { factorMethods } from "./access.js";
import { consumeTotpCode } from "./totp.js";

/**
 * A session may enroll its first authenticator app. Replacing that app, or
 * registering a passkey, needs the current password or a code from the
 * authenticator already on the account. An account with neither (single
 * sign-on, no authenticator yet) keeps the session it just opened.
 */
export async function assertMayChangeFactor(
  db: Database,
  key: Buffer,
  userId: string,
  kind: "totp" | "passkey",
  proof: { password?: string; factorCode?: string },
): Promise<void> {
  const methods = await factorMethods(db, userId);
  if (kind === "totp" && !methods.includes("totp")) return;

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
