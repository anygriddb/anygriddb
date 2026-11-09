import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto.js";

describe("AES-256-GCM", () => {
  it("round-trips a TOTP secret and rejects a short key", () => {
    const key = randomBytes(32);
    const sealed = encryptSecret("JBSWY3DPEHPK3PXP", key);
    expect(decryptSecret(sealed.ciphertext, sealed.nonce, key)).toBe(
      "JBSWY3DPEHPK3PXP",
    );
    expect(() => encryptSecret("secret", Buffer.from("short"))).toThrow(
      /32 bytes/,
    );
  });
});
