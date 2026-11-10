import { createHash, randomInt, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LENGTH = 10;

/**
 * Random backup code, each character drawn uniformly (`randomInt` rejects
 * the draws a modulo would bias). SHA-256 is a code hash here, not a
 * password hash.
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

export function hashBackupCode(code: string): string {
  return createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
}

export function backupCodeMatches(hash: string, code: string): boolean {
  const candidate = Buffer.from(hashBackupCode(code));
  const stored = Buffer.from(hash);
  return (
    candidate.length === stored.length && timingSafeEqual(candidate, stored)
  );
}
