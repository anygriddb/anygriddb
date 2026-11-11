/**
 * A sign-up proves its address before any account exists (ADR 0058): the
 * first account and an invited address are made at once; any other waits
 * for the link mailed to it, opened with the password chosen at sign-up.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { clearSmtpCache } from "../integrations/smtp.js";
import { fakeSmtp, mailText } from "../mail.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
} from "../trpc/caller.test-helpers.js";
import {
  createSignupRequest,
  MAX_PENDING_PER_ADDRESS,
  purgeSignupRequests,
} from "./signup-requests.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const LINK = /https:\/\/grid\.example\.org\/signup\/([A-Za-z0-9_-]{43})/;

describe("sign-up", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
    SMTP_FROM: "grid@example.org",
    ADMIN_EMAILS: `listed-${suffix}@example.org`,
  } as unknown as Env & { SMTP_HOST?: string; SMTP_PORT?: number };
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();

  const accountOf = (email: string) =>
    db
      .selectFrom("users")
      .select(["id", "isAdmin", "displayName"])
      .where("email", "=", email)
      .executeTakeFirst();
  const pending = async (email: string) =>
    (
      await db
        .selectFrom("signupRequests")
        .select("id")
        .where("email", "=", email)
        .execute()
    ).length;
  const mailOn = () => {
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;
    clearSmtpCache(db);
  };
  /** The link of the next sign-up mail to `email`. */
  const linkFor = async (email: string) => {
    const text = mailText(await smtp.next(email));
    const token = LINK.exec(text)?.[1];
    if (!token) throw new Error(`no link in: ${text}`);
    return token;
  };

  beforeAll(async () => {
    const created = await createTestDatabase("signup");
    db = created.db;
    close = created.close;
    smtp = await fakeSmtp();
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await close?.();
  });

  it("makes the first account at once: it sets the instance up", async () => {
    const email = `first-${suffix}@example.org`;
    // No email is needed for it, and the page knows.
    expect((await admin.call().auth.instance()).signupNeedsMail).toBe(false);
    expect(
      await admin.call().auth.signup({
        email,
        displayName: "First",
        password: PASSWORD,
      }),
    ).toEqual({ status: "session" });
    expect((await accountOf(email))?.isAdmin).toBe(true);
    await enrollTotp(admin);
  });

  it("refuses any other sign-up while the instance cannot send email", async () => {
    const email = `nomail-${suffix}@example.org`;
    const page = browser();
    expect(
      await errorCode(
        page
          .call()
          .auth.signup({ email, displayName: "No", password: PASSWORD }),
      ),
    ).toBe("signup_needs_mail");
    expect(await accountOf(email)).toBeUndefined();
    expect(await pending(email)).toBe(0);
    expect(page.jar).toEqual({});
    expect((await page.call().auth.instance()).signupNeedsMail).toBe(true);
  });

  it("makes the account only once the link is opened with the same password", async () => {
    mailOn();
    const email = `ben-${suffix}@example.org`;
    const page = browser();
    expect((await page.call().auth.instance()).signupNeedsMail).toBe(false);
    expect(
      await page
        .call({ "accept-language": "fr-FR,fr;q=0.9" })
        .auth.signup({ email, displayName: "Ben", password: PASSWORD }),
    ).toEqual({ status: "verify" });
    // No account and no session yet: only a request.
    expect(await accountOf(email)).toBeUndefined();
    expect(page.jar).toEqual({});
    expect(await pending(email)).toBe(1);
    const mail = await smtp.next(email);
    expect(mailText(mail)).toContain("confirmer votre adresse");
    const token = LINK.exec(mailText(mail))?.[1] ?? "";

    // Opened elsewhere: the link says which address, and wants the password.
    const other = browser();
    expect(await other.call().auth.signupLink({ token })).toEqual({
      valid: true,
      email,
    });
    expect(
      await errorCode(
        other
          .call()
          .auth.confirmSignup({ token, password: "not the password" }),
      ),
    ).toBe("invalid_credentials");
    expect(await accountOf(email)).toBeUndefined();

    expect(
      await other.call().auth.confirmSignup({ token, password: PASSWORD }),
    ).toEqual({ status: "session" });
    expect(await accountOf(email)).toMatchObject({
      displayName: "Ben",
      isAdmin: false,
    });
    expect(await other.call().session.current()).toMatchObject({ email });
    const opened = await db
      .selectFrom("authEvents as e")
      .innerJoin("users as u", "u.id", "e.userId")
      .select(["e.action", "e.method"])
      .where("u.email", "=", email)
      .execute();
    expect(opened).toEqual([{ action: "login_success", method: "signup" }]);
    // Every request for the address is gone; the link is spent.
    expect(await pending(email)).toBe(0);
    expect(await other.call().auth.signupLink({ token })).toEqual({
      valid: false,
    });
    expect(
      await errorCode(
        browser().call().auth.confirmSignup({ token, password: PASSWORD }),
      ),
    ).toBe("invalid_signup_link");
  });

  it("answers the same for an address that has an account, and tells that address", async () => {
    const email = `ben-${suffix}@example.org`;
    expect(
      await browser().call().auth.signup({
        email,
        displayName: "Someone",
        password: "another long password",
      }),
    ).toEqual({ status: "verify" });
    expect(mailText(await smtp.next(email))).toContain("already has one");
    expect(await pending(email)).toBe(0);
    expect((await accountOf(email))?.displayName).toBe("Ben");
  });

  it("mails no more than a few links to one address", async () => {
    const email = `flood-${suffix}@example.org`;
    for (let index = 0; index <= MAX_PENDING_PER_ADDRESS; index += 1) {
      expect(
        await browser().call().auth.signup({
          email,
          displayName: "Flood",
          password: PASSWORD,
        }),
      ).toEqual({ status: "verify" });
    }
    expect(await pending(email)).toBe(MAX_PENDING_PER_ADDRESS);
    for (let index = 0; index < MAX_PENDING_PER_ADDRESS; index += 1) {
      await linkFor(email);
    }
    await expect(smtp.next(email, 300)).rejects.toThrow("no mail");
  });

  it("counts sign-ups that race for an address no request names yet", async () => {
    const email = `race-${suffix}@example.org`;
    const made = await Promise.all(
      Array.from({ length: MAX_PENDING_PER_ADDRESS + 3 }, () =>
        createSignupRequest(db, {
          email,
          displayName: "Race",
          passwordHash: "not-a-hash",
        }),
      ),
    );
    expect(made.filter((link) => link !== null)).toHaveLength(
      MAX_PENDING_PER_ADDRESS,
    );
    expect(await pending(email)).toBe(MAX_PENDING_PER_ADDRESS);
  });

  it("makes an address of ADMIN_EMAILS an administrator only once it is proved", async () => {
    const email = `listed-${suffix}@example.org`;
    await browser().call().auth.signup({
      email,
      displayName: "Listed",
      password: PASSWORD,
    });
    expect(await accountOf(email)).toBeUndefined();
    const token = await linkFor(email);
    await browser().call().auth.confirmSignup({ token, password: PASSWORD });
    expect((await accountOf(email))?.isAdmin).toBe(true);
  });

  it("makes an invited address's account at once, and only that address's", async () => {
    const base = await admin.call().catalog.createBase({ name: "Shared" });
    const invited = `guest-${suffix}@example.org`;
    const invitation = await admin.call().catalog.invite({
      baseId: base.id,
      email: invited,
      role: "viewer",
    });
    // The invitation's link reached `invited`, not this address.
    const stranger = `stranger-${suffix}@example.org`;
    expect(
      await browser()
        .call()
        .auth.signup({
          email: stranger,
          displayName: "Stranger",
          password: PASSWORD,
          invitation: invitation.token ?? "",
        }),
    ).toEqual({ status: "verify" });
    expect(await accountOf(stranger)).toBeUndefined();

    const guest = browser();
    expect(
      await guest.call().auth.signup({
        email: invited,
        displayName: "Guest",
        password: PASSWORD,
        invitation: invitation.token ?? "",
      }),
    ).toEqual({ status: "session" });
    expect(await accountOf(invited)).toMatchObject({ isAdmin: false });
  });

  it("lets go of the requests nobody answered", async () => {
    const email = `late-${suffix}@example.org`;
    await browser().call().auth.signup({
      email,
      displayName: "Late",
      password: PASSWORD,
    });
    await linkFor(email);
    await db
      .updateTable("signupRequests")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("email", "=", email)
      .execute();
    expect(await purgeSignupRequests(db)).toBeGreaterThanOrEqual(1);
    expect(await pending(email)).toBe(0);
  });
});
