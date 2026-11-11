import { describe, expect, it } from "vitest";
import {
  generateBackupCode,
  hashBackupCode,
  legacyBackupCodeHash,
} from "./backup-code.js";

const key = Buffer.alloc(32, 7);

describe("backup codes", () => {
  it("hashes a random code under the instance key, however it is typed", () => {
    const code = generateBackupCode();
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    const hash = hashBackupCode(code, key);
    expect(hash).toHaveLength(64);
    expect(
      hashBackupCode(
        ` ${code.slice(0, 5)}-${code.slice(5)} `.toLowerCase(),
        key,
      ),
    ).toBe(hash);
  });

  it("gives another hash to another code, another key, or no key", () => {
    const code = generateBackupCode();
    const hash = hashBackupCode(code, key);
    expect(hashBackupCode("ZZZZZZZZZZ", key)).not.toBe(hash);
    expect(hashBackupCode(code, Buffer.alloc(32, 8))).not.toBe(hash);
    expect(legacyBackupCodeHash(code)).not.toBe(hash);
    expect(legacyBackupCodeHash(code)).toHaveLength(64);
  });
});
