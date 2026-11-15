import { createHash } from "node:crypto";

/** SHA-256 hex of a secret the product never stores in clear text. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
