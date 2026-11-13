import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  backupCodeHashes,
  generateBackupCode,
  hashBackupCode,
} from "./backup-code.js";
import { keyRing, parseKeyRing } from "./key-ring.js";

const master = Buffer.alloc(32, 7);
const key = keyRing(master);

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

  it("gives another hash to another code or another key", () => {
    const code = generateBackupCode();
    const hash = hashBackupCode(code, key);
    expect(hashBackupCode("ZZZZZZZZZZ", key)).not.toBe(hash);
    expect(hashBackupCode(code, keyRing(Buffer.alloc(32, 8)))).not.toBe(hash);
  });

  it("still matches a code stored before a key change, or before this release", () => {
    const code = generateBackupCode();
    const changed = parseKeyRing(
      `next:${Buffer.alloc(32, 9).toString("base64")}`,
      `0:${master.toString("base64")}`,
    );
    const accepted = backupCodeHashes(code, changed);
    // Stored under the current key, then under the one before it.
    expect(accepted[0]).toBe(hashBackupCode(code, changed));
    expect(accepted).toContain(hashBackupCode(code, key));
    // As releases before key identifiers stored it: the master itself.
    expect(accepted).toContain(
      createHmac("sha256", master).update(code).digest("hex"),
    );
    // And as the first releases did: a bare SHA-256.
    expect(accepted).toContain(createHash("sha256").update(code).digest("hex"));
    // A key the instance no longer holds matches nothing.
    expect(
      backupCodeHashes(code, keyRing(Buffer.alloc(32, 9), "next")),
    ).not.toContain(hashBackupCode(code, key));
  });
});
