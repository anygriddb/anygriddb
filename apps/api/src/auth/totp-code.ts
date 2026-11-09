import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "@anygriddb/core";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

export function encodeBase32(bytes: Buffer): string {
  let value = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32.charAt((value << (5 - bits)) & 31);
  }
  return output;
}

export function decodeBase32(secret: string): Buffer {
  const normalized = secret.replace(/=+$/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(normalized)) {
    throw new AppError("invalid_totp_secret");
  }
  let value = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32.indexOf(char);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpCode(secret: Buffer, atMs: number): string {
  const counter = BigInt(Math.floor(atMs / STEP_MS));
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", secret).update(counterBytes).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const first = hmac[offset] ?? 0;
  const second = hmac[offset + 1] ?? 0;
  const third = hmac[offset + 2] ?? 0;
  const fourth = hmac[offset + 3] ?? 0;
  const binary =
    ((first & 0x7f) << 24) | (second << 16) | (third << 8) | fourth;
  return String(binary % 1_000_000).padStart(6, "0");
}

function codesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function acceptedTotpStep(
  secretBase32: string,
  code: string,
  atMs = Date.now(),
  lastStep: number | null = null,
): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  let secret: Buffer;
  try {
    secret = decodeBase32(secretBase32);
  } catch {
    return null;
  }
  const base = Math.floor(atMs / STEP_MS);
  for (const skew of [-1, 0, 1]) {
    const step = base + skew;
    if (lastStep !== null && step <= lastStep) {
      continue;
    }
    if (codesMatch(totpCode(secret, step * STEP_MS), code)) {
      return step;
    }
  }
  return null;
}

export function verifyTotp(
  secretBase32: string,
  code: string,
  atMs = Date.now(),
): boolean {
  if (!/^\d{6}$/.test(code)) {
    return false;
  }
  let secret: Buffer;
  try {
    secret = decodeBase32(secretBase32);
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid totp secret") {
      return false;
    }
    throw error;
  }
  for (const skew of [-1, 0, 1]) {
    if (codesMatch(totpCode(secret, atMs + skew * STEP_MS), code)) {
      return true;
    }
  }
  return false;
}

export function totpUri(secret: string, account: string): string {
  const label = encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secret}&issuer=AnyGridDB&algorithm=SHA1&digits=6&period=30`;
}
