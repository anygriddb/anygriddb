import { createHash } from "node:crypto";

/**
 * SHA-256 hex of a high-entropy token (authorization codes, refresh
 * tokens). Client secrets use Argon2id instead.
 */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
