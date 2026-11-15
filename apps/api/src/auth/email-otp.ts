/**
 * Six-digit codes mailed to an account as its second factor (ADR 0085).
 * A code is kept as an HMAC under the instance's key, one at a time for
 * an account and a purpose, ten minutes, five guesses. A mailbox is sent
 * one code a minute and five an hour at most.
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import { AppError } from "@anygriddb/core";
import type { Database, EmailOtpPurpose } from "@anygriddb/db";
import { sign, signatures, type KeyRing } from "./key-ring.js";

export const EMAIL_OTP_TTL_MS = 10 * 60_000;
export const EMAIL_OTP_ATTEMPT_LIMIT = 5;
/** A code a minute at most, and five an hour, for an account and a purpose. */
export const EMAIL_OTP_SEND_GAP_MS = 60_000;
export const EMAIL_OTP_SEND_HOUR_LIMIT = 5;
const HOUR_MS = 60 * 60_000;

export function generateEmailOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashEmailOtp(code: string, key: KeyRing): string {
  return sign(key, "email-otp", code.trim()).toString("hex");
}

/** A code under the current key and under the earlier ones still read. */
function matches(stored: string, code: string, key: KeyRing): boolean {
  const kept = Buffer.from(stored, "hex");
  let found = false;
  for (const candidate of signatures(key, "email-otp", code.trim())) {
    if (kept.length === candidate.length && timingSafeEqual(kept, candidate)) {
      found = true;
    }
  }
  return found;
}

/** Whether the account has confirmed its address as a second factor. */
export async function hasEmailFactor(
  db: Database,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("emailFactors")
    .select("userId")
    .where("userId", "=", userId)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Makes a new code for this purpose, in place of the one before, and
 * gives its guesses back. Refused with `email_otp_rate_limited` when a
 * code was sent in the last minute, or five in the last hour. One
 * statement decides: two requests at once send one code.
 */
export async function issueEmailOtp(
  db: Database,
  userId: string,
  purpose: EmailOtpPurpose,
  key: KeyRing,
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateEmailOtp();
  const expiresAt = new Date(now.getTime() + EMAIL_OTP_TTL_MS);
  const codeHash = hashEmailOtp(code, key);
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const minuteAgo = new Date(now.getTime() - EMAIL_OTP_SEND_GAP_MS);
  const written = await db
    .insertInto("emailOtpCodes")
    .values({
      userId,
      purpose,
      codeHash,
      expiresAt,
      attempts: 0,
      sendCount: 1,
      windowStart: now,
      sentAt: now,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["userId", "purpose"])
        .doUpdateSet((eb) => ({
          codeHash,
          expiresAt,
          attempts: 0,
          sentAt: now,
          // The hour starts again once the one before is over.
          sendCount: eb
            .case()
            .when("emailOtpCodes.windowStart", "<=", hourAgo)
            .then(1)
            .else(eb("emailOtpCodes.sendCount", "+", 1))
            .end(),
          windowStart: eb
            .case()
            .when("emailOtpCodes.windowStart", "<=", hourAgo)
            .then(now)
            .else(eb.ref("emailOtpCodes.windowStart"))
            .end(),
        }))
        .where("emailOtpCodes.sentAt", "<=", minuteAgo)
        .where((eb) =>
          eb.or([
            eb("emailOtpCodes.windowStart", "<=", hourAgo),
            eb("emailOtpCodes.sendCount", "<", EMAIL_OTP_SEND_HOUR_LIMIT),
          ]),
        ),
    )
    .returning("userId")
    .executeTakeFirst();
  if (!written) throw new AppError("email_otp_rate_limited");
  return { code, expiresAt };
}

/**
 * Takes the code once. A guess is counted before it is compared, in one
 * statement, so guesses sent together are each counted: the fifth wrong
 * one leaves a code that takes no more. A right code is deleted as it is
 * taken, and of two requests that give it together one is told so.
 */
export async function consumeEmailOtp(
  db: Database,
  userId: string,
  purpose: EmailOtpPurpose,
  code: string,
  key: KeyRing,
  now: Date = new Date(),
): Promise<boolean> {
  const guessed = await db
    .updateTable("emailOtpCodes")
    .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
    .where("userId", "=", userId)
    .where("purpose", "=", purpose)
    .where("expiresAt", ">", now)
    .where("attempts", "<", EMAIL_OTP_ATTEMPT_LIMIT)
    .returning("codeHash")
    .executeTakeFirst();
  if (!guessed || !matches(guessed.codeHash, code, key)) return false;
  const taken = await db
    .deleteFrom("emailOtpCodes")
    .where("userId", "=", userId)
    .where("purpose", "=", purpose)
    .where("codeHash", "=", guessed.codeHash)
    .returning("userId")
    .executeTakeFirst();
  return taken !== undefined;
}

export async function confirmEmailFactor(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insertInto("emailFactors")
    .values({ userId, confirmedAt: now })
    .onConflict((conflict) =>
      conflict.column("userId").doUpdateSet({ confirmedAt: now }),
    )
    .execute();
}

export async function clearEmailFactor(
  db: Database,
  userId: string,
): Promise<void> {
  await db.deleteFrom("emailFactors").where("userId", "=", userId).execute();
  await db.deleteFrom("emailOtpCodes").where("userId", "=", userId).execute();
}
