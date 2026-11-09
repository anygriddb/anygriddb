import { describe, expect, it } from "vitest";
import {
  backupCodeMatches,
  generateBackupCode,
  hashBackupCode,
} from "./backup-code.js";

describe("backup codes", () => {
  it("hashes a random code and rejects a different one", () => {
    const code = generateBackupCode();
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    const hash = hashBackupCode(` ${code.slice(0, 5)}-${code.slice(5)} `);
    expect(hash).toHaveLength(64);
    expect(backupCodeMatches(hash, code)).toBe(true);
    expect(backupCodeMatches(hash, "ZZZZZZZZZZ")).toBe(false);
  });
});
