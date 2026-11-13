import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  currentKey,
  keyOf,
  mastersBeforeIds,
  type KeyRing,
  type KeyUse,
} from "./key-ring.js";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** First byte of a value sealed under a named key (ADR 0066). */
const SEALED_WITH_ID = 0x01;

function seal(plaintext: string, key: Buffer, nonce: Buffer): Buffer {
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

/** The plaintext, or undefined when this key did not seal these bytes. */
function open(sealed: Buffer, nonce: Buffer, key: Buffer): string | undefined {
  if (sealed.length < TAG_BYTES) return undefined;
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // The tag did not match: another key sealed this, or it was altered.
    return undefined;
  }
}

/** `[0x01][length of the id][id][sealed bytes]`, or undefined. */
function splitKeyId(
  ciphertext: Buffer,
): { id: string; sealed: Buffer } | undefined {
  const length = ciphertext[1];
  if (
    ciphertext[0] !== SEALED_WITH_ID ||
    length === undefined ||
    length === 0 ||
    ciphertext.length < 2 + length
  ) {
    return undefined;
  }
  return {
    id: ciphertext.subarray(2, 2 + length).toString("utf8"),
    sealed: ciphertext.subarray(2 + length),
  };
}

/**
 * Seals a secret with the current key of its use (AES-256-GCM). The
 * key's identifier travels in front of the sealed bytes, so that a later
 * key change still knows which key opens them.
 */
export function encryptSecret(
  plaintext: string,
  ring: KeyRing,
  use: KeyUse,
): { ciphertext: Buffer; nonce: Buffer } {
  const { id, key } = currentKey(ring, use);
  const nonce = randomBytes(NONCE_BYTES);
  const name = Buffer.from(id, "utf8");
  return {
    ciphertext: Buffer.concat([
      Buffer.from([SEALED_WITH_ID, name.length]),
      name,
      seal(plaintext, key, nonce),
    ]),
    nonce,
  };
}

/**
 * Opens a sealed secret and says which key sealed it: its identifier, or
 * null for a value sealed before keys had one, with a master key itself.
 *
 * Such an older value has no mark of its own, and its first byte can be
 * anything: the bytes are read as carrying an identifier first, then as
 * an older value under each master the ring holds. The authentication tag
 * decides, so a wrong reading opens nothing.
 */
export function openSecret(
  ciphertext: Buffer,
  nonce: Buffer,
  ring: KeyRing,
  use: KeyUse,
): { plaintext: string; keyId: string | null } {
  const named = splitKeyId(ciphertext);
  const key = named ? keyOf(ring, named.id, use) : undefined;
  if (named && key) {
    const plaintext = open(named.sealed, nonce, key);
    if (plaintext !== undefined) return { plaintext, keyId: named.id };
  }
  for (const master of mastersBeforeIds(ring)) {
    const plaintext = open(ciphertext, nonce, master);
    if (plaintext !== undefined) return { plaintext, keyId: null };
  }
  throw new Error("No key of this instance opens this secret");
}

/** The secret, sealed by any key the ring holds. */
export function decryptSecret(
  ciphertext: Buffer,
  nonce: Buffer,
  ring: KeyRing,
  use: KeyUse,
): string {
  return openSecret(ciphertext, nonce, ring, use).plaintext;
}
