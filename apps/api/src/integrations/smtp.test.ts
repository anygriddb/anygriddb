import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { smtpReady, type SmtpConfig } from "../mail.js";
import { publicSmtp, type SmtpRow } from "./smtp.js";

const KEY = randomBytes(32);

function seal(plaintext: string): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
    nonce,
  };
}

describe("publicSmtp", () => {
  it("hides the password and marks a saved row", () => {
    const sealed = seal("secret");
    const row: SmtpRow = {
      host: "smtp.example.org",
      port: 465,
      username: "grid@example.org",
      fromAddress: "grid@example.org",
      passwordCiphertext: sealed.ciphertext,
      passwordNonce: sealed.nonce,
      updatedAt: new Date("2026-11-11T00:00:00.000Z"),
      updatedBy: null,
    };
    const shown = publicSmtp(row);
    expect(shown).toEqual({
      configured: true,
      host: "smtp.example.org",
      port: 465,
      username: "grid@example.org",
      fromAddress: "grid@example.org",
      hasPassword: true,
      updatedAt: "2026-11-11T00:00:00.000Z",
    });
    expect(JSON.stringify(shown)).not.toContain("secret");
  });

  it("reports an empty instance", () => {
    expect(publicSmtp(null).configured).toBe(false);
    expect(publicSmtp(null).hasPassword).toBe(false);
  });
});

describe("smtpReady", () => {
  it("needs host and from", () => {
    const ready: SmtpConfig = {
      SMTP_HOST: "127.0.0.1",
      SMTP_FROM: "grid@example.org",
    };
    expect(smtpReady(ready)).toBe(true);
    expect(smtpReady({ SMTP_HOST: "127.0.0.1" })).toBe(false);
    expect(smtpReady({ SMTP_FROM: "grid@example.org" })).toBe(false);
  });
});
