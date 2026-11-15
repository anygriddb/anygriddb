import { describe, expect, it } from "vitest";
import { generateEmailOtp, hashEmailOtp } from "./email-otp.js";
import { keyRing } from "./key-ring.js";

const key = keyRing(Buffer.alloc(32, 7));

describe("a code mailed as a second factor", () => {
  it("is six digits, zeros in front included", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateEmailOtp()).toMatch(/^\d{6}$/);
    }
  });

  it("is kept as an HMAC under the instance's key, not as it is", () => {
    const hash = hashEmailOtp("042137", key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("042137");
    // Spaces a person pastes around it change nothing.
    expect(hashEmailOtp(" 042137 ", key)).toBe(hash);
    expect(hashEmailOtp("042138", key)).not.toBe(hash);
    // Another instance's key gives another HMAC of the same code.
    expect(hashEmailOtp("042137", keyRing(Buffer.alloc(32, 8)))).not.toBe(hash);
  });
});
