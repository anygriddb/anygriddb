import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function encryptSecret(
  plaintext: string,
  key: Buffer,
): { ciphertext: Buffer; nonce: Buffer } {
  if (key.length !== 32) {
    throw new Error("AES-256-GCM key must be 32 bytes");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
  return { ciphertext, nonce };
}

export function decryptSecret(
  ciphertext: Buffer,
  nonce: Buffer,
  key: Buffer,
): string {
  if (key.length !== 32) {
    throw new Error("AES-256-GCM key must be 32 bytes");
  }
  if (ciphertext.length < TAG_BYTES) {
    throw new Error("Ciphertext too short");
  }
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString(
    "utf8",
  );
}
