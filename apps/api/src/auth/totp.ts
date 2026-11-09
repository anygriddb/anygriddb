import type { Database } from "@anygriddb/db";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { acceptedTotpStep } from "./totp-code.js";

/** Stores a confirmed TOTP secret. The plaintext is not written to the table. */
export async function saveTotpSecret(
  db: Database,
  userId: string,
  secret: string,
  key: Buffer,
  lastStep: number,
): Promise<void> {
  const sealed = encryptSecret(secret, key);
  const confirmedAt = new Date();
  await db
    .insertInto("totpSecrets")
    .values({
      userId,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      confirmedAt,
      lastStep,
    })
    .onConflict((conflict) =>
      conflict.column("userId").doUpdateSet({
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        confirmedAt,
        lastStep,
      }),
    )
    .execute();
}

export async function readTotpRow(db: Database, userId: string) {
  const row = await db
    .selectFrom("totpSecrets")
    .selectAll()
    .where("userId", "=", userId)
    .executeTakeFirst();
  return row ?? null;
}

export async function readTotpSecret(
  db: Database,
  userId: string,
  key: Buffer,
): Promise<string | null> {
  const row = await readTotpRow(db, userId);
  if (!row?.confirmedAt) {
    return null;
  }
  return decryptSecret(row.ciphertext, row.nonce, key);
}

/**
 * Accepts a code once. A reused time step is rejected, and the step is
 * recorded only if it is newer, so two requests racing with the same code
 * cannot both pass.
 */
export async function consumeTotpCode(
  db: Database,
  userId: string,
  code: string,
  key: Buffer,
): Promise<boolean> {
  const row = await readTotpRow(db, userId);
  if (!row?.confirmedAt) {
    return false;
  }
  const secret = decryptSecret(row.ciphertext, row.nonce, key);
  const step = acceptedTotpStep(secret, code, Date.now(), row.lastStep);
  if (step === null) {
    return false;
  }
  const recorded = await db
    .updateTable("totpSecrets")
    .set({ lastStep: step })
    .where("userId", "=", userId)
    .where((eb) =>
      eb.or([eb("lastStep", "is", null), eb("lastStep", "<", step)]),
    )
    .returning("userId")
    .executeTakeFirst();
  return Boolean(recorded);
}
