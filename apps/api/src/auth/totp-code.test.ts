import { describe, expect, it } from "vitest";
import {
  decodeBase32,
  encodeBase32,
  totpCode,
  verifyTotp,
} from "./totp-code.js";

describe("totp", () => {
  it("matches the RFC 6238 SHA-1 vector and rejects a wrong code", () => {
    const secret = Buffer.from("12345678901234567890");
    expect(totpCode(secret, 59_000)).toBe("287082");
    const encoded = encodeBase32(secret);
    expect(decodeBase32(encoded).equals(secret)).toBe(true);
    expect(verifyTotp(encoded, "287082", 59_000)).toBe(true);
    expect(verifyTotp(encoded, "000000", 59_000)).toBe(false);
    expect(verifyTotp("not-base32", "287082", 59_000)).toBe(false);
  });

  it("refuses a long run of padding in one pass", () => {
    const started = performance.now();
    expect(() => decodeBase32(`${"=".repeat(200_000)}A`)).toThrow();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(decodeBase32("MFRGG===").toString()).toBe("abc");
  });
});
