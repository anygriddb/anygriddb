/**
 * A code by email as a second factor (ADR 0085), against a real database
 * and a mail server: the code's guesses and sends are counted where two
 * requests cannot both pass; a member chooses it, signs in with it, and
 * keeps the backup codes they had; an administrator is refused it, and one
 * who had it is asked for another factor; nothing is sent where mail is
 * not set up, and the second step is still asked.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setUserAdmin } from "../admin.js";
import { clearFactors } from "../admin-control.js";
import type { Env } from "../env.js";
import { clearSmtpCache } from "../integrations/smtp.js";
import { fakeSmtp, mailText } from "../mail.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  emailOtpFromMail,
  enrollTotp,
  errorCode,
  signUpProved,
  type TestBrowser,
} from "../trpc/caller.test-helpers.js";
import { MFA_COOKIE } from "./challenge.js";
import {
  consumeEmailOtp,
  EMAIL_OTP_ATTEMPT_LIMIT,
  EMAIL_OTP_SEND_GAP_MS,
  EMAIL_OTP_SEND_HOUR_LIMIT,
  EMAIL_OTP_TTL_MS,
  issueEmailOtp,
} from "./email-otp.js";
import { keyRing } from "./key-ring.js";
import { SESSION_COOKIE } from "./session.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const MINUTE = 60_000;

describe("a code by email as a second factor", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  const key = keyRing(randomBytes(32));
  const env = {
    AUTH_ENCRYPTION_KEY: key,
    PUBLIC_URL: "https://grid.example.org",
    SMTP_FROM: "grid@example.org",
  } as unknown as Env & { SMTP_HOST?: string; SMTP_PORT?: number };
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  let administrator: TestBrowser;
  let administratorId = "";
  const address = (name: string) => `${name}-${suffix}@example.org`;

  const mailOn = () => {
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;
    clearSmtpCache(db);
  };
  const mailOff = () => {
    delete env.SMTP_HOST;
    clearSmtpCache(db);
  };
  /** A member with a password, signed in in a browser of their own. */
  const member = async (name: string) => {
    const page = browser();
    const id = await signUpProved(page, db, {
      email: address(name),
      displayName: name,
      password: PASSWORD,
    });
    return { page, id, email: address(name) };
  };
  /** The code of the next mail the address receives. */
  const mailed = async (to: string) =>
    emailOtpFromMail(mailText(await smtp.next(to)));
  /** Lets the next code leave: the minute between two sends, gone by. */
  const aMinuteLater = (userId: string) =>
    db
      .updateTable("emailOtpCodes")
      .set({ sentAt: new Date(Date.now() - 2 * MINUTE) })
      .where("userId", "=", userId)
      .execute();
  const enrolled = async (name: string) => {
    const person = await member(name);
    await person.page.call().auth.email.begin({});
    const confirmed = await person.page
      .call()
      .auth.email.confirm({ code: await mailed(person.email) });
    return { ...person, backupCodes: confirmed.backupCodes };
  };

  beforeAll(async () => {
    const created = await createTestDatabase("email_factor");
    db = created.db;
    close = created.close;
    smtp = await fakeSmtp();
    mailOn();
    administrator = browser();
    await administrator.signUpFirst({
      email: address("admin"),
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    administratorId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", address("admin"))
        .executeTakeFirstOrThrow()
    ).id;
    // An administrator works once they have a factor of their own.
    await enrollTotp(administrator);
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await close?.();
  });

  beforeEach(() => {
    smtp.received.length = 0;
    mailOn();
  });

  describe("the code", () => {
    it("works once, until it is too old", async () => {
      const { id } = await member("once");
      const now = new Date();
      const { code } = await issueEmailOtp(db, id, "login", key, now);
      // Kept as an HMAC: the table does not hold the code.
      const kept = await db
        .selectFrom("emailOtpCodes")
        .select("codeHash")
        .where("userId", "=", id)
        .executeTakeFirstOrThrow();
      expect(kept.codeHash).not.toContain(code);
      // A code made to sign in does not enrol.
      expect(await consumeEmailOtp(db, id, "enroll", code, key)).toBe(false);
      expect(await consumeEmailOtp(db, id, "login", code, key)).toBe(true);
      expect(await consumeEmailOtp(db, id, "login", code, key)).toBe(false);

      const late = new Date(now.getTime() + 2 * MINUTE);
      const again = await issueEmailOtp(db, id, "login", key, late);
      const tooLate = new Date(late.getTime() + EMAIL_OTP_TTL_MS);
      expect(
        await consumeEmailOtp(db, id, "login", again.code, key, tooLate),
      ).toBe(false);
    });

    it("takes five guesses, counted even when they come together", async () => {
      const { id } = await member("guesses");
      const { code } = await issueEmailOtp(db, id, "login", key);
      const wrong = code === "000000" ? "111111" : "000000";
      // Twenty wrong guesses at once: five are counted, and no more.
      const guesses = await Promise.all(
        Array.from({ length: 20 }, () =>
          consumeEmailOtp(db, id, "login", wrong, key),
        ),
      );
      expect(guesses.every((taken) => !taken)).toBe(true);
      const kept = await db
        .selectFrom("emailOtpCodes")
        .select("attempts")
        .where("userId", "=", id)
        .executeTakeFirstOrThrow();
      expect(kept.attempts).toBe(EMAIL_OTP_ATTEMPT_LIMIT);
      // The right code comes too late: the guesses are spent.
      expect(await consumeEmailOtp(db, id, "login", code, key)).toBe(false);
    });

    it("opens one door when the right code is given twice at once", async () => {
      const { id } = await member("twice");
      const { code } = await issueEmailOtp(db, id, "login", key);
      const taken = await Promise.all([
        consumeEmailOtp(db, id, "login", code, key),
        consumeEmailOtp(db, id, "login", code, key),
      ]);
      expect(taken.filter(Boolean)).toHaveLength(1);
    });

    it("leaves a minute between two sends, and sends five an hour", async () => {
      const { id } = await member("sends");
      const start = new Date("2026-11-15T12:00:00Z");
      const at = (ms: number) => new Date(start.getTime() + ms);
      const first = await issueEmailOtp(db, id, "login", key, start);
      await expect(
        issueEmailOtp(db, id, "login", key, at(EMAIL_OTP_SEND_GAP_MS - 1)),
      ).rejects.toMatchObject({ code: "email_otp_rate_limited" });
      // Two requests at the same instant: one code leaves.
      const together = await Promise.allSettled([
        issueEmailOtp(db, id, "login", key, at(2 * MINUTE)),
        issueEmailOtp(db, id, "login", key, at(2 * MINUTE)),
      ]);
      expect(
        together.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      // The code before no longer works: one code at a time.
      expect(
        await consumeEmailOtp(db, id, "login", first.code, key, at(3 * MINUTE)),
      ).toBe(false);
      for (let sent = 2; sent < EMAIL_OTP_SEND_HOUR_LIMIT; sent += 1) {
        await issueEmailOtp(db, id, "login", key, at((2 + 2 * sent) * MINUTE));
      }
      // The sixth of the hour is refused, however long after the fifth.
      await expect(
        issueEmailOtp(db, id, "login", key, at(40 * MINUTE)),
      ).rejects.toMatchObject({ code: "email_otp_rate_limited" });
      // A new hour, a new count; and another purpose has its own.
      await issueEmailOtp(db, id, "enroll", key, at(40 * MINUTE));
      await issueEmailOtp(db, id, "login", key, at(61 * MINUTE));
      const kept = await db
        .selectFrom("emailOtpCodes")
        .select(["sendCount", "attempts"])
        .where("userId", "=", id)
        .where("purpose", "=", "login")
        .executeTakeFirstOrThrow();
      expect(kept).toEqual({ sendCount: 1, attempts: 0 });
    });
  });

  it("is chosen by a member, who then signs in with a mailed code", async () => {
    const person = await member("pat");
    // No second factor yet: nothing to prove to choose a first one.
    const begun = await person.page.call().auth.email.begin({});
    expect(Date.parse(begun.expiresAt)).toBeGreaterThan(Date.now());
    const mail = mailText(await smtp.next(person.email));
    const code = emailOtpFromMail(mail);
    // The mail holds the code and no link to follow.
    expect(mail).not.toMatch(/https?:\/\//);
    expect(
      await errorCode(
        person.page.call().auth.email.confirm({
          code: code === "000000" ? "111111" : "000000",
        }),
      ),
    ).toBe("email_otp_invalid");
    const confirmed = await person.page.call().auth.email.confirm({ code });
    // A first factor: the account gets its backup codes.
    expect(confirmed.backupCodes).toHaveLength(8);
    expect(await person.page.call().session.current()).toMatchObject({
      mfaEnrolled: true,
      mfaMethods: ["email"],
    });

    await person.page.call().auth.logout();
    const login = await person.page
      .call()
      .auth.login({ email: person.email, password: PASSWORD });
    expect(login).toEqual({ status: "mfa", methods: ["email"] });
    expect(person.page.jar[SESSION_COOKIE]).toBeFalsy();
    expect(person.page.jar[MFA_COOKIE]).toBeTruthy();
    // Nothing is mailed until the person asks.
    expect(smtp.received).toHaveLength(0);
    await person.page.call().auth.email.send();
    const loginCode = await mailed(person.email);
    // A second code within the minute is refused.
    expect(await errorCode(person.page.call().auth.email.send())).toBe(
      "email_otp_rate_limited",
    );
    expect(
      await errorCode(
        person.page.call().auth.email.verify({
          code: loginCode === "000000" ? "111111" : "000000",
        }),
      ),
    ).toBe("UNAUTHORIZED");
    expect(
      await person.page.call().auth.email.verify({ code: loginCode }),
    ).toEqual({ status: "session" });
    expect(await person.page.call().session.current()).toMatchObject({
      email: person.email,
      mfaEnrolled: true,
    });
    // The sign-in trail says how the second step was passed.
    const events = await db
      .selectFrom("authEvents")
      .select(["action", "method"])
      .where("userId", "=", person.id)
      .where("method", "=", "email")
      .execute();
    expect(events.map((event) => event.action).sort()).toEqual([
      "login_failure",
      "login_success",
    ]);
  });

  it("asks the password before it joins an authenticator, and leaves the saved backup codes", async () => {
    const person = await member("tess");
    await enrollTotp(person.page);
    const codesBefore = await db
      .selectFrom("backupCodes")
      .select("codeHash")
      .where("userId", "=", person.id)
      .execute();
    expect(codesBefore).toHaveLength(8);
    // A borrowed session alone opens no second way in.
    expect(await errorCode(person.page.call().auth.email.begin({}))).toBe(
      "invalid_credentials",
    );
    expect(
      await errorCode(
        person.page.call().auth.email.begin({ password: "not the password" }),
      ),
    ).toBe("invalid_credentials");
    expect(smtp.received).toHaveLength(0);
    await person.page.call().auth.email.begin({ password: PASSWORD });
    const confirmed = await person.page
      .call()
      .auth.email.confirm({ code: await mailed(person.email) });
    expect(confirmed.backupCodes).toEqual([]);
    expect(
      await db
        .selectFrom("backupCodes")
        .select("codeHash")
        .where("userId", "=", person.id)
        .execute(),
    ).toEqual(codesBefore);
    expect((await person.page.call().session.current())?.mfaMethods).toEqual([
      "totp",
      "email",
    ]);

    // Turned off with the password, and not without.
    expect(await errorCode(person.page.call().auth.email.disable({}))).toBe(
      "invalid_credentials",
    );
    await person.page.call().auth.email.disable({ password: PASSWORD });
    expect((await person.page.call().session.current())?.mfaMethods).toEqual([
      "totp",
    ]);
  });

  it("is refused to an administrator, and no longer counts for a member made one", async () => {
    expect(await errorCode(administrator.call().auth.email.begin({}))).toBe(
      "email_factor_administrator",
    );
    expect(
      await errorCode(
        administrator.call().auth.email.confirm({ code: "123456" }),
      ),
    ).toBe("email_factor_administrator");
    expect(smtp.received).toHaveLength(0);

    const person = await enrolled("promoted");
    // Administration's list counts it as the member's second factor.
    const counted = async () =>
      (
        await administrator
          .call()
          .admin.users({ search: person.email, mfa: true })
      ).users.map((user) => user.id);
    expect(await counted()).toEqual([person.id]);
    await setUserAdmin(db, administratorId, person.id, true);
    expect(await counted()).toEqual([]);
    // The policy asks an administrator for a factor: the code by email
    // is none for them.
    expect(await person.page.call().session.current()).toMatchObject({
      isAdmin: true,
      mfaEnrolled: false,
      mfaMethods: [],
      mfaRequired: true,
    });
    // Their sign-in is the password alone, and offers no code by email.
    await person.page.call().auth.logout();
    expect(
      await person.page
        .call()
        .auth.login({ email: person.email, password: PASSWORD }),
    ).toEqual({ status: "session", methods: [] });
    expect(await errorCode(person.page.call().auth.email.send())).toBe(
      "UNAUTHORIZED",
    );
    // No longer an administrator, they have the factor they chose again.
    await setUserAdmin(db, administratorId, person.id, false);
    expect((await person.page.call().session.current())?.mfaMethods).toEqual([
      "email",
    ]);
  });

  it("sends nothing where mail is not set up, and still asks the second step", async () => {
    const person = await enrolled("offline");
    const fresh = await member("fresh");
    mailOff();
    expect(await errorCode(fresh.page.call().auth.email.begin({}))).toBe(
      "smtp_not_configured",
    );
    await person.page.call().auth.logout();
    // The factor is still asked: the sign-in does not fall back on the
    // password alone.
    expect(
      await person.page
        .call()
        .auth.login({ email: person.email, password: PASSWORD }),
    ).toEqual({ status: "mfa", methods: ["email"] });
    expect(await errorCode(person.page.call().auth.email.send())).toBe(
      "smtp_not_configured",
    );
    // A backup code is the way in while mail is down.
    expect(
      await person.page
        .call()
        .auth.backup.verify({ code: person.backupCodes[0] ?? "" }),
    ).toEqual({ status: "session" });
  });

  it("says so when the mail server refuses the code, and counts the send", async () => {
    const person = await member("bounced");
    // A port nothing listens on: the send fails.
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = 9;
    clearSmtpCache(db);
    expect(await errorCode(person.page.call().auth.email.begin({}))).toBe(
      "email_otp_not_sent",
    );
    mailOn();
    // The code that did not leave still counts: one a minute.
    expect(await errorCode(person.page.call().auth.email.begin({}))).toBe(
      "email_otp_rate_limited",
    );
    await aMinuteLater(person.id);
    await person.page.call().auth.email.begin({});
    expect(await mailed(person.email)).toMatch(/^\d{6}$/);
  });

  it("goes with the account's other factors when an administrator clears them", async () => {
    const person = await enrolled("cleared");
    await clearFactors(db, administratorId, person.id);
    expect(
      await db
        .selectFrom("emailFactors")
        .select("userId")
        .where("userId", "=", person.id)
        .execute(),
    ).toEqual([]);
    expect(
      await person.page
        .call()
        .auth.login({ email: person.email, password: PASSWORD }),
    ).toEqual({ status: "session", methods: [] });
  });
});
