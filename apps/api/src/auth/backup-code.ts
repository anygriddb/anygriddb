import { createHash, randomInt } from "node:crypto";
import { sign, signatures, type KeyRing } from "./key-ring.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LENGTH = 10;

/**
 * Random backup code, each character drawn uniformly (`randomInt` rejects
 * the draws a modulo would bias). Stored codes are HMAC-SHA-256 under the
 * instance's current key for this use, not a password hash. Codes stored
 * under an earlier key, under the key itself before it had an identifier,
 * or as bare SHA-256 before that, still match until they are used.
 */
export function generateBackupCode(): string {
  let code = "";
  for (let index = 0; index < LENGTH; index += 1) {
    code += ALPHABET.charAt(randomInt(ALPHABET.length));
  }
  return code;
}

function normalizeBackupCode(code: string): string {
  return code.trim().replace(/-/g, "").toUpperCase();
}

export function hashBackupCode(code: string, key: KeyRing): string {
  return sign(key, "backup-code", normalizeBackupCode(code)).toString("hex");
}

/** Every form a stored code may have: one matches, whatever key hashed it. */
export function backupCodeHashes(code: string, key: KeyRing): string[] {
  return [
    ...signatures(key, "backup-code", normalizeBackupCode(code)).map((hash) =>
      hash.toString("hex"),
    ),
    legacyBackupCodeHash(code),
  ];
}

/** Bare SHA-256, kept so a code issued before HMAC still works once. */
function legacyBackupCodeHash(code: string): string {
  return createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
}
