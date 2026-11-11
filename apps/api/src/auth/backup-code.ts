import { createHash, createHmac, randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LENGTH = 10;

/**
 * Random backup code, each character drawn uniformly (`randomInt` rejects
 * the draws a modulo would bias). Stored codes are HMAC-SHA-256 under the
 * instance key, not a password hash. Older rows are bare SHA-256 and still
 * match until they are used.
 */
export function generateBackupCode(): string {
  let code = "";
  for (let index = 0; index < LENGTH; index += 1) {
    code += ALPHABET.charAt(randomInt(ALPHABET.length));
  }
  return code;
}

export function normalizeBackupCode(code: string): string {
  return code.trim().replace(/-/g, "").toUpperCase();
}

export function hashBackupCode(code: string, key: Buffer): string {
  return createHmac("sha256", key)
    .update(normalizeBackupCode(code))
    .digest("hex");
}

/** Bare SHA-256, kept so a code issued before HMAC still works once. */
export function legacyBackupCodeHash(code: string): string {
  return createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
}
