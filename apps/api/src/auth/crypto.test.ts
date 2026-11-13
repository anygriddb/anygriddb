import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, openSecret } from "./crypto.js";
import { keyRing, parseKeyRing, sign, verify } from "./key-ring.js";

/** A value as every release before key identifiers sealed it. */
function sealedBeforeIds(plaintext: string, master: Buffer, nonce: Buffer) {
  const cipher = createCipheriv("aes-256-gcm", master, nonce);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

const base64 = (bytes: Buffer) => bytes.toString("base64");

describe("sealed secrets", () => {
  const oldMaster = randomBytes(32);
  const newMaster = randomBytes(32);
  const before = keyRing(oldMaster);
  const after = parseKeyRing(
    `2026:${base64(newMaster)}`,
    `0:${base64(oldMaster)}`,
  );

  it("seals under the current key of a use, and names that key", () => {
    const sealed = encryptSecret("JBSWY3DPEHPK3PXP", after, "totp");
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.ciphertext.subarray(0, 6).toString("latin1")).toBe(
      "\u0001\u00042026",
    );
    expect(openSecret(sealed.ciphertext, sealed.nonce, after, "totp")).toEqual({
      plaintext: "JBSWY3DPEHPK3PXP",
      keyId: "2026",
    });
    // Sealed with a key derived for the use, never with the master.
    const derived = Buffer.from(
      hkdfSync("sha256", newMaster, Buffer.alloc(0), "anygriddb:totp", 32),
    );
    expect(
      sealedBeforeIds("JBSWY3DPEHPK3PXP", derived, sealed.nonce).equals(
        sealed.ciphertext.subarray(6),
      ),
    ).toBe(true);
  });

  it("opens what an earlier key sealed, while the ring keeps that key", () => {
    const sealed = encryptSecret("smtp-password", before, "smtp");
    expect(openSecret(sealed.ciphertext, sealed.nonce, after, "smtp")).toEqual({
      plaintext: "smtp-password",
      keyId: "0",
    });
    expect(() =>
      decryptSecret(
        sealed.ciphertext,
        sealed.nonce,
        keyRing(newMaster, "2026"),
        "smtp",
      ),
    ).toThrow("No key of this instance opens this secret");
  });

  it("refuses a value of another use, an altered one, and a truncated one", () => {
    const sealed = encryptSecret("hunter2", after, "source");
    expect(() =>
      decryptSecret(sealed.ciphertext, sealed.nonce, after, "webhook"),
    ).toThrow();
    const altered = Buffer.from(sealed.ciphertext);
    altered[altered.length - 1] = (altered.at(-1) ?? 0) ^ 1;
    expect(() =>
      decryptSecret(altered, sealed.nonce, after, "source"),
    ).toThrow();
    expect(() =>
      decryptSecret(
        sealed.ciphertext.subarray(0, 8),
        sealed.nonce,
        after,
        "source",
      ),
    ).toThrow();
  });

  it("opens a value sealed before keys had identifiers, whatever its first byte", () => {
    // Such a value has no mark: one in 256 starts with the byte that now
    // announces an identifier. Nonces are tried until each case is met.
    const seen = { marked: 0, plain: 0 };
    for (let n = 0; seen.marked < 3 || seen.plain < 3; n += 1) {
      const nonce = randomBytes(12);
      const sealed = sealedBeforeIds(`secret ${String(n)}`, oldMaster, nonce);
      if (sealed[0] === 0x01) seen.marked += 1;
      else seen.plain += 1;
      // By the key that sealed it, alone or kept beside a newer one.
      for (const ring of [before, after]) {
        expect(openSecret(sealed, nonce, ring, "totp")).toEqual({
          plaintext: `secret ${String(n)}`,
          keyId: null,
        });
      }
    }
    expect(seen.marked).toBe(3);
  });

  it("reads the keys an operator gives, and refuses what is not one", () => {
    expect(parseKeyRing(base64(oldMaster)).currentId).toBe("0");
    expect([...after.masters.keys()]).toEqual(["2026", "0"]);
    expect(() => parseKeyRing("c2hvcnQ=")).toThrow(/32 bytes/);
    expect(() => parseKeyRing(`a b:${base64(oldMaster)}`)).toThrow(
      /identifier/,
    );
    expect(() =>
      parseKeyRing(`1:${base64(newMaster)}`, `1:${base64(oldMaster)}`),
    ).toThrow(/given twice/);
    expect(() => keyRing(Buffer.from("short"))).toThrow(/32 bytes/);
  });
});

describe("signatures under the key ring", () => {
  const oldMaster = randomBytes(32);
  const before = keyRing(oldMaster);
  const after = parseKeyRing(
    `b:${randomBytes(32).toString("base64")}`,
    `0:${oldMaster.toString("base64")}`,
  );

  it("recognises what the current key, an earlier key, or a master itself signed", () => {
    const text = "share.1700000000000";
    expect(
      verify(after, "share-access", text, sign(after, "share-access", text)),
    ).toBe(true);
    expect(
      verify(after, "share-access", text, sign(before, "share-access", text)),
    ).toBe(true);
    // Before keys had identifiers, the master signed as it was.
    const bare = createHmac("sha256", oldMaster).update(text).digest();
    expect(verify(after, "share-access", text, bare)).toBe(true);
  });

  it("refuses another text, another use, and a key the ring does not hold", () => {
    const text = "share.1700000000000";
    const mac = sign(after, "share-access", text);
    expect(verify(after, "share-access", `${text}0`, mac)).toBe(false);
    expect(verify(after, "backup-code", text, mac)).toBe(false);
    expect(verify(before, "share-access", text, mac)).toBe(false);
    expect(verify(after, "share-access", text, mac.subarray(0, 16))).toBe(
      false,
    );
  });
});
