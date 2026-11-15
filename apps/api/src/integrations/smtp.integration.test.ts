/**
 * Operator SMTP (ADR 0050, 0083): save through the admin router once the
 * relay answers, send a test mail, never return the password; a relay the
 * environment names wins, is shown, and is not changed from the page.
 */
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
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
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
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
    await admin.signUpFirst({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    // Saving SMTP asks for a proof again (ROADMAP #28): given once here,
    // it stands for the five minutes these tests take.
    await admin.call().admin.stepUp({ password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await close?.();
  });

  it("has no relay while neither the environment nor the page names one", async () => {
    clearSmtpCache(db);
    expect((await resolveSmtp(db, env)).source).toBe("none");
    // Half a relay in the environment is none.
    env.SMTP_FROM = "env@example.org";
    expect((await resolveSmtp(db, env)).source).toBe("none");
    delete env.SMTP_FROM;
    const got = await admin.call().admin.smtp.get();
    expect(got).toMatchObject({ source: "none", ready: false, host: null });
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

  it("lets the environment's relay win, shows it, and does not change it", async () => {
    // A row is saved on the page, then the operator names a relay.
    expect((await admin.call().admin.smtp.get()).source).toBe("database");
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;
    env.SMTP_FROM = "env@example.org";
    env.SMTP_USER = "relay";
    env.SMTP_PASSWORD = "never-shown";
    try {
      const resolved = await resolveSmtp(db, env);
      expect(resolved.source).toBe("env");
      expect(resolved.config.SMTP_FROM).toBe("env@example.org");

      // The page shows what is in force, never its password; the row
      // saved before is still there, unused.
      const got = await admin.call().admin.smtp.get();
      expect(got).toMatchObject({
        source: "env",
        ready: true,
        configured: true,
        host: "127.0.0.1",
        port: smtp.port,
        username: "relay",
        fromAddress: "env@example.org",
        hasPassword: true,
        updatedAt: null,
      });
      expect(JSON.stringify(got)).not.toContain("never-shown");

      // A save is refused, and the row stays as it was.
      expect(
        await errorCode(
          admin.call().admin.smtp.update({
            host: "127.0.0.1",
            port: smtp.port,
            username: null,
            fromAddress: "other@example.org",
          }),
        ),
      ).toBe("set_by_environment");
      const row = await db
        .selectFrom("instanceSmtp")
        .select("fromAddress")
        .executeTakeFirstOrThrow();
      expect(row.fromAddress).toBe("grid@example.org");

      // The unused row can be removed; the environment's relay stays.
      await admin.call().admin.smtp.clear();
      const after = await admin.call().admin.smtp.get();
      expect(after).toMatchObject({ source: "env", configured: false });
    } finally {
      delete env.SMTP_HOST;
      delete env.SMTP_PORT;
      delete env.SMTP_FROM;
      delete env.SMTP_USER;
      delete env.SMTP_PASSWORD;
    }
    clearSmtpCache(db);
    expect((await resolveSmtp(db, env)).source).toBe("none");
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
