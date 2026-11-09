import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Random backup code. SHA-256 is a code hash here, not a password hash. */
export function generateBackupCode(): string {
  const bytes = randomBytes(10);
  let code = "";
  for (const byte of bytes) {
    code += ALPHABET.charAt(byte % ALPHABET.length);
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
