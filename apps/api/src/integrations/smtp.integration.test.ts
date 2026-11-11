/**
 * Operator SMTP (ADR 0050): save through the admin router once the relay
 * answers, resolve prefers the database, send a test mail, never return
 * the password.
 */
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { fakeSmtp, mailText } from "../mail.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  signUpProved,
} from "../trpc/caller.test-helpers.js";
import { clearSmtpCache, resolveSmtp } from "./smtp.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("operator SMTP", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
    SMTP_FROM: "env@example.org",
  } as unknown as Env & {
    SMTP_HOST?: string;
    SMTP_PORT?: number;
    SMTP_FROM?: string;
  };

  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();

  beforeAll(async () => {
    const created = await createTestDatabase("smtp");
    db = created.db;
    close = created.close;
    smtp = await fakeSmtp();
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;
    await admin.call().auth.signup({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await close?.();
  });

  it("falls back to the environment when nothing is saved", async () => {
    clearSmtpCache(db);
    const resolved = await resolveSmtp(db, env);
    expect(resolved.source).toBe("env");
    expect(resolved.config.SMTP_FROM).toBe("env@example.org");
  });

  it("saves through the UI path, hides the password, and sends a test", async () => {
    const saved = await admin.call().admin.smtp.update({
      host: "127.0.0.1",
      port: smtp.port,
      username: null,
      fromAddress: "grid@example.org",
      password: null,
    });
    expect(saved.configured).toBe(true);
    expect(saved.host).toBe("127.0.0.1");
    expect(saved.fromAddress).toBe("grid@example.org");
    expect(JSON.stringify(saved)).not.toMatch(/ciphertext|SMTP_PASSWORD/i);
    expect(saved).not.toHaveProperty("password");

    clearSmtpCache(db);
    const resolved = await resolveSmtp(db, env);
    expect(resolved.source).toBe("database");
    expect(resolved.config.SMTP_FROM).toBe("grid@example.org");

    const sent = await admin.call().admin.sendTestMail();
    expect(sent.to).toContain(`admin-${suffix}@example.org`);
    const mail = await smtp.next(sent.to);
    expect(mailText(mail)).toMatch(/test|test message|message de test/i);

    const got = await admin.call().admin.smtp.get();
    expect(got.source).toBe("database");
    expect(got.ready).toBe(true);
    expect(JSON.stringify(got)).not.toMatch(/ciphertext|SMTP_PASSWORD/i);
  });

  it("saves nothing a relay refuses", async () => {
    // A port nothing listens on: the one a server just gave back.
    const gone = createServer();
    await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
    const { port } = gone.address() as AddressInfo;
    await new Promise<void>((resolve) => gone.close(() => resolve()));
    expect(
      await errorCode(
        admin.call().admin.smtp.update({
          host: "127.0.0.1",
          port,
          fromAddress: "broken@example.org",
        }),
      ),
    ).toBe("invalid_smtp");
    const kept = await admin.call().admin.smtp.get();
    expect(kept.fromAddress).toBe("grid@example.org");
    expect(kept.port).toBe(smtp.port);
  });

  it("drops the stored password with the username", async () => {
    const withAccount = await admin.call().admin.smtp.update({
      host: "127.0.0.1",
      port: smtp.port,
      username: "relay",
      fromAddress: "grid@example.org",
      password: "relay-secret",
    });
    expect(withAccount.hasPassword).toBe(true);
    // Omitted: the password stays.
    const kept = await admin.call().admin.smtp.update({
      host: "127.0.0.1",
      port: smtp.port,
      username: "relay",
      fromAddress: "grid@example.org",
    });
    expect(kept.hasPassword).toBe(true);
    const open = await admin.call().admin.smtp.update({
      host: "127.0.0.1",
      port: smtp.port,
      username: null,
      fromAddress: "grid@example.org",
    });
    expect(open.username).toBeNull();
    expect(open.hasPassword).toBe(false);
  });

  it("clears the row and falls back to env again", async () => {
    await admin.call().admin.smtp.clear();
    clearSmtpCache(db);
    const resolved = await resolveSmtp(db, env);
    expect(resolved.source).toBe("env");
  });

  it("refuses a member", async () => {
    const member = browser();
    await signUpProved(member, db, {
      email: `member-${suffix}@example.org`,
      displayName: "Max",
      password: PASSWORD,
    });
    expect(
      await errorCode(
        member.call().admin.smtp.update({
          host: "127.0.0.1",
          port: smtp.port,
          fromAddress: "x@example.org",
        }),
      ),
    ).toBe("access_denied");
  });
});
