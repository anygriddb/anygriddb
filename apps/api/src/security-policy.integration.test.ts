/**
 * The security policy of ADR 0043, through the real tRPC router on a
 * migrated database and a mail server on the loopback: who needs a second
 * factor, locked accounts, password rules, changes and resets, sessions,
 * tokens, public links, sign-up domains, and the trail of who changed what.
 */
import { randomBytes } from "node:crypto";
import type { InstanceSettingsPatch } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  listUsers,
  setUserAdmin,
  setUserDisabled,
  updateAccount,
} from "./admin.js";
import {
  accessReportCsv,
  eraseInfo,
  eraseOtherAccount,
  otherAccount,
} from "./admin-control.js";
import { requestActor } from "./auth/access.js";
import { purgeAuthEvents, recordAuthEvent } from "./auth/auth-events.js";
import { sweepInactiveAccounts } from "./auth/inactivity.js";
import { createResetLink, purgeResetLinks } from "./auth/password-reset.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { createApiToken } from "./auth/tokens.js";
import { addComment } from "./data/comments.js";
import { ERASED_USER_ID, eraseAccount } from "./data/erasure.js";
import { grantMember, soleOwnerBases } from "./data/members.js";
import { createInvitation, createShare, resolveShare } from "./data/sharing.js";
import { withAudit } from "./data/audit-context.js";
import { insertBase, insertTable } from "./data/schema-ops.js";
import type { Env } from "./env.js";
import { fakeSmtp, mailText } from "./mail.test-helpers.js";
import { createTestDatabase } from "./test-database.js";
import { decodeBase32, totpCode } from "./auth/totp-code.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
  signUpProved,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("the security policy", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  const hub = {
    closeUser: vi.fn(() => 0),
    closeAllBut: vi.fn(() => 0),
    closeSession: vi.fn(() => 0),
  };
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
    SMTP_FROM: "grid@example.org",
  } as unknown as Env & { SMTP_HOST?: string; SMTP_PORT?: number };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();
  let adminId = "";
  let n = 0;

  /** A new account, signed in on its own browser. */
  async function account(name: string) {
    n += 1;
    const email = `${name.toLowerCase()}-${String(n)}-${suffix}@example.org`;
    const page = browser();
    const id = await signUpProved(page, db, {
      email,
      displayName: name,
      password: PASSWORD,
    });
    return { email, id, page };
  }

  async function signIn(email: string, password = PASSWORD, page = browser()) {
    return {
      page,
      result: await code(page.call().auth.login({ email, password })),
    };
  }

  async function trail(userId: string) {
    return db
      .selectFrom("authEvents")
      .select(["action", "detail", "actorId", "method"])
      .where("userId", "=", userId)
      .orderBy("occurredAt")
      .orderBy("id")
      .execute();
  }

  const policy = (patch: InstanceSettingsPatch) =>
    admin.call().admin.updateSettings(patch);

  beforeAll(async () => {
    const created = await createTestDatabase("policy");
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
    adminId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("isAdmin", "=", true)
        .executeTakeFirstOrThrow()
    ).id;
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await close?.();
  });

  beforeEach(() => {
    smtp.received.length = 0;
  });

  describe("second factor", () => {
    it("is required of every administrator, whatever the scope", async () => {
      const other = await account("Grace");
      await admin.call().admin.setAdmin({ userId: other.id, admin: true });
      await policy({ mfaScope: "admins" });
      try {
        expect(await code(other.page.call().admin.users({}))).toBe(
          "mfa_enrollment_required",
        );
        expect(await other.page.call().session.current()).toMatchObject({
          mfaEnrolled: false,
          mfaRequired: true,
        });
        await enrollTotp(other.page);
        expect(await code(other.page.call().admin.users({}))).toBe("ok");
      } finally {
        await policy({ mfaScope: "owners" });
      }
    });

    it("lets owners work without one when the scope is administrators", async () => {
      const owner = await account("Olive");
      expect(
        await code(owner.page.call().catalog.createBase({ name: "Mine" })),
      ).toBe("mfa_enrollment_required");
      expect((await owner.page.call().session.current())?.mfaForBases).toBe(
        true,
      );
      await policy({ mfaScope: "admins" });
      try {
        expect(
          await code(owner.page.call().catalog.createBase({ name: "Mine" })),
        ).toBe("ok");
        expect(await code(owner.page.call().catalog.list())).toBe("ok");
      } finally {
        await policy({ mfaScope: "owners" });
      }
      // Back to the default, the owner is asked for one again.
      expect(await code(owner.page.call().catalog.list())).toBe(
        "mfa_enrollment_required",
      );
    });

    it("can be required of everyone", async () => {
      const member = await account("Mia");
      const token = (await createApiToken(db, member.id, "script")).token;
      const asToken = () =>
        requestActor(db, { authorization: `Bearer ${token}` }, undefined);
      expect(await code(asToken())).toBe("ok");
      await policy({ mfaScope: "everyone" });
      try {
        expect(await code(asToken())).toBe("mfa_enrollment_required");
        expect((await member.page.call().session.current())?.mfaRequired).toBe(
          true,
        );
      } finally {
        await policy({ mfaScope: "owners" });
      }
    });
  });

  describe("locked accounts", () => {
    it("locks after the threshold, refuses even the right password, and mails the person", async () => {
      await policy({ lockoutThreshold: 3, lockoutMinutes: 15 });
      const target = await account("Lou");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await signIn(target.email, "wrong password here")).result).toBe(
          "invalid_credentials",
        );
      }
      expect((await signIn(target.email)).result).toBe("account_locked");
      const mail = await smtp.next(target.email);
      expect(mailText(mail)).toContain("After 3 failed sign-in attempts");
      const listed = await admin.call().admin.users({ search: target.email });
      expect(listed.users[0]?.lock?.until).toMatch(/^\d{4}-/);
      const actions = (await trail(target.id)).map((event) => [
        event.action,
        event.detail,
      ]);
      expect(actions.slice(-2)).toEqual([
        ["account_locked", null],
        ["login_failure", "account_locked"],
      ]);
    });

    it("lets the lock run out, by the policy in force", async () => {
      const target = await account("Ray");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await signIn(target.email, "wrong password here");
      }
      expect((await signIn(target.email)).result).toBe("account_locked");
      // Twenty minutes ago: past the 15 the policy gives.
      await db
        .updateTable("users")
        .set({ lockedAt: sql<Date>`now() - interval '20 minutes'` })
        .where("id", "=", target.id)
        .execute();
      expect((await signIn(target.email)).result).toBe("ok");
      const row = await db
        .selectFrom("users")
        .select(["failedSignIns", "lockedAt"])
        .where("id", "=", target.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ failedSignIns: 0, lockedAt: null });
    });

    it("waits for an administrator when the policy says so", async () => {
      await policy({ lockoutMinutes: 0 });
      try {
        const target = await account("Sam");
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await signIn(target.email, "wrong password here");
        }
        await db
          .updateTable("users")
          .set({ lockedAt: sql<Date>`now() - interval '30 days'` })
          .where("id", "=", target.id)
          .execute();
        expect((await signIn(target.email)).result).toBe("account_locked");
        const listed = await admin.call().admin.users({ search: target.email });
        expect(listed.users[0]?.lock).toEqual({ until: null });
        expect(await code(admin.call().admin.unlock({ userId: adminId }))).toBe(
          "invalid_account",
        );
        await admin.call().admin.unlock({ userId: target.id });
        expect((await signIn(target.email)).result).toBe("ok");
        const unlocked = (await trail(target.id)).find(
          (event) => event.action === "account_unlocked",
        );
        expect(unlocked).toMatchObject({ actorId: adminId, method: "admin" });
      } finally {
        await policy({ lockoutMinutes: 15 });
      }
    });

    it("counts wrong second-factor codes, and stops the second step once locked", async () => {
      const target = await account("Kim");
      const secret = await enrollTotp(target.page);
      expect(secret).toMatch(/^[A-Z2-7]+$/);
      const page = browser();
      expect((await signIn(target.email, PASSWORD, page)).result).toBe("ok");
      for (const wrong of ["000000", "111111", "222222"]) {
        expect(await code(page.call().auth.totp.verify({ code: wrong }))).toBe(
          "UNAUTHORIZED",
        );
      }
      expect(await code(page.call().auth.totp.verify({ code: "123456" }))).toBe(
        "account_locked",
      );
      expect((await signIn(target.email)).result).toBe("account_locked");
    });

    it("never locks an administrator for good", async () => {
      await policy({ lockoutMinutes: 0 });
      try {
        await db
          .updateTable("users")
          .set({ lockedAt: sql<Date>`now() - interval '2 hours'` })
          .where("id", "=", adminId)
          .execute();
        const listed = await admin.call().admin.users({
          search: `admin-${suffix}`,
        });
        expect(listed.users[0]?.lock).toBeNull();
      } finally {
        await db
          .updateTable("users")
          .set({ lockedAt: null, failedSignIns: 0 })
          .where("id", "=", adminId)
          .execute();
        await policy({ lockoutMinutes: 15 });
      }
    });
  });

  describe("passwords", () => {
    it("holds every new password to the policy's length", async () => {
      await policy({ passwordMinLength: 20 });
      try {
        expect(
          await code(
            browser()
              .call()
              .auth.signup({
                email: `short-${suffix}@example.org`,
                displayName: "Short",
                password: "only-sixteen-chr",
              }),
          ),
        ).toBe("password_too_short");
        expect((await browser().call().auth.instance()).passwordMinLength).toBe(
          20,
        );
      } finally {
        await policy({ passwordMinLength: 12 });
      }
    });

    it("changes a password and ends the other sessions, not this one", async () => {
      const person = await account("Cleo");
      const made = await person.page
        .call()
        .auth.createToken({ name: "script" });
      const other = (await signIn(person.email)).page;
      expect(await code(other.call().catalog.list())).toBe("ok");
      expect(
        await code(
          person.page.call().auth.changePassword({
            current: "not my password at all",
            password: "a brand new passphrase",
          }),
        ),
      ).toBe("invalid_credentials");
      await person.page.call().auth.changePassword({
        current: PASSWORD,
        password: "a brand new passphrase",
      });
      expect(await code(person.page.call().catalog.list())).toBe("ok");
      expect(await code(other.call().catalog.list())).toBe("UNAUTHORIZED");
      expect(
        await requestActor(
          db,
          { authorization: `Bearer ${made.token}` },
          undefined,
        ),
      ).toBeNull();
      expect((await signIn(person.email)).result).toBe("invalid_credentials");
      expect(
        (await signIn(person.email, "a brand new passphrase")).result,
      ).toBe("ok");
      expect(mailText(await smtp.next(person.email))).toContain(
        "password of your AnyGridDB account was just changed",
      );
      expect((await trail(person.id)).map((event) => event.action)).toContain(
        "password_changed",
      );
    });

    it("mails a reset link the person asked for, which works once", async () => {
      const person = await account("Ivy");
      const made = await person.page
        .call()
        .auth.createToken({ name: "script" });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await signIn(person.email, "wrong password here");
      }
      expect(mailText(await smtp.next(person.email))).toContain("locked");
      const page = browser();
      await page.call().auth.requestPasswordReset({ email: person.email });
      // An unknown address gets the same answer, and no mail.
      await page.call().auth.requestPasswordReset({
        email: `nobody-${suffix}@example.org`,
      });
      const mail = mailText(await smtp.next(person.email));
      const token = /\/reset\/([A-Za-z0-9_-]{43})/.exec(mail)?.[1] ?? "";
      expect(token).not.toBe("");
      expect(await page.call().auth.resetLink({ token })).toEqual({
        valid: true,
        passwordMinLength: 12,
      });
      expect(
        await code(
          page
            .call()
            .auth.resetPassword({ token, password: "a fresh passphrase" }),
        ),
      ).toBe("ok");
      // The link is spent, the lock is gone, and the old sessions ended.
      expect(
        await code(
          page
            .call()
            .auth.resetPassword({ token, password: "once more, again" }),
        ),
      ).toBe("invalid_reset_link");
      expect(await code(person.page.call().catalog.list())).toBe(
        "UNAUTHORIZED",
      );
      expect(
        await requestActor(
          db,
          { authorization: `Bearer ${made.token}` },
          undefined,
        ),
      ).toBeNull();
      expect((await signIn(person.email, "a fresh passphrase")).result).toBe(
        "ok",
      );
      const nobody = `nobody-${suffix}@example.org`;
      expect(smtp.received.some((mail) => mail.to.includes(nobody))).toBe(
        false,
      );
      const actions = (await trail(person.id)).map((event) => [
        event.action,
        event.detail,
      ]);
      expect(actions).toContainEqual([
        "password_reset_requested",
        "self_service",
      ]);
      expect(actions).toContainEqual(["password_reset", "self_service"]);
    });

    it("lets an administrator send a link: by mail, or to pass on without email", async () => {
      const person = await account("Noor");
      const mailed = await admin
        .call()
        .admin.sendPasswordReset({ userId: person.id });
      expect(mailed).toEqual({ sent: true, to: person.email });
      expect(mailText(await smtp.next(person.email))).toContain(
        "An administrator sent you a link",
      );
      const host = env.SMTP_HOST;
      delete env.SMTP_HOST;
      try {
        const handed = await admin
          .call()
          .admin.sendPasswordReset({ userId: person.id });
        expect(handed.sent).toBe(false);
        const token = handed.sent
          ? ""
          : (handed.link.split("/reset/")[1] ?? "");
        expect(
          await code(
            browser().call().auth.requestPasswordReset({ email: person.email }),
          ),
        ).toBe("password_reset_disabled");
        await browser().call().auth.resetPassword({
          token,
          password: "set by a handed link",
        });
        expect(
          (await signIn(person.email, "set by a handed link")).result,
        ).toBe("ok");
      } finally {
        env.SMTP_HOST = host;
      }
      const reset = (await trail(person.id)).filter(
        (event) => event.action === "password_reset_requested",
      );
      expect(reset.every((event) => event.actorId === adminId)).toBe(true);
      expect((await trail(person.id)).at(-2)).toMatchObject({
        action: "password_reset",
        detail: "admin_reset",
      });
    });

    it("lets an administrator create an account and hand a reset link", async () => {
      await policy({ signup: "closed" });
      try {
        const email = `provisioned-${suffix}@example.org`;
        expect(
          await code(
            browser().call().auth.signup({
              email,
              displayName: "Blocked",
              password: PASSWORD,
            }),
          ),
        ).toBe("signup_closed");
        const mailed = await admin.call().admin.createUser({
          email,
          displayName: "Provisioned Person",
        });
        expect(mailed).toEqual({
          userId: expect.any(String),
          sent: true,
          to: email,
        });
        expect(mailText(await smtp.next(email))).toContain(
          "An administrator sent you a link",
        );
        expect((await signIn(email, PASSWORD)).result).toBe(
          "invalid_credentials",
        );
        const host = env.SMTP_HOST;
        delete env.SMTP_HOST;
        try {
          expect(
            await code(
              admin.call().admin.createUser({
                email,
                displayName: "Again",
              }),
            ),
          ).toBe("account_already_exists");
          const other = `handed-${suffix}@example.org`;
          const handed = await admin.call().admin.createUser({
            email: other,
            displayName: "Handed Person",
          });
          expect(handed.sent).toBe(false);
          const token = handed.sent
            ? ""
            : (handed.link.split("/reset/")[1] ?? "");
          await browser().call().auth.resetPassword({
            token,
            password: "first password from admin",
          });
          expect(
            (await signIn(other, "first password from admin")).result,
          ).toBe("ok");
        } finally {
          env.SMTP_HOST = host;
        }
        expect(
          await code(
            browser()
              .call()
              .admin.createUser({
                email: `intruder-${suffix}@example.org`,
                displayName: "No",
              }),
          ),
        ).toBe("UNAUTHORIZED");
      } finally {
        await policy({ signup: "open" });
      }
    });

    it("refuses a link for an account that signs in only by SSO, and an expired one", async () => {
      const sso = await db
        .insertInto("users")
        .values({ email: `sso-${suffix}@example.org`, displayName: "Sso" })
        .returning("id")
        .executeTakeFirstOrThrow();
      expect(
        await code(admin.call().admin.sendPasswordReset({ userId: sso.id })),
      ).toBe("sso_account");
      // Spent or expired links are deleted after a week.
      await db
        .insertInto("passwordResets")
        .values({
          userId: adminId,
          tokenHash: `old-${suffix}`,
          expiresAt: sql<Date>`now() - interval '8 days'`,
        })
        .execute();
      expect(await purgeResetLinks(db)).toBe(1);
      const person = await account("Eve");
      const host = env.SMTP_HOST;
      delete env.SMTP_HOST;
      try {
        const handed = await admin
          .call()
          .admin.sendPasswordReset({ userId: person.id });
        const token = handed.sent
          ? ""
          : (handed.link.split("/reset/")[1] ?? "");
        await db
          .updateTable("passwordResets")
          .set({ expiresAt: sql<Date>`now() - interval '1 minute'` })
          .where("userId", "=", person.id)
          .execute();
        expect((await browser().call().auth.resetLink({ token })).valid).toBe(
          false,
        );
      } finally {
        env.SMTP_HOST = host;
      }
    });

    it("lets only an administrator start a reset when the policy says so", async () => {
      await policy({ passwordReset: "admin" });
      try {
        expect((await browser().call().auth.instance()).selfReset).toBe(false);
        expect(
          await code(
            browser()
              .call()
              .auth.requestPasswordReset({
                email: `admin-${suffix}@example.org`,
              }),
          ),
        ).toBe("password_reset_disabled");
      } finally {
        await policy({ passwordReset: "self" });
      }
      expect((await browser().call().auth.instance()).selfReset).toBe(true);
    });
  });

  describe("sessions and tokens", () => {
    it("issues sessions for the policy's idle window", async () => {
      await policy({ sessionIdleMinutes: 60 });
      try {
        const person = await account("Ada");
        const session = await db
          .selectFrom("sessions")
          .select(["createdAt", "expiresAt"])
          .where("userId", "=", person.id)
          .executeTakeFirstOrThrow();
        const minutes =
          (session.expiresAt.getTime() - session.createdAt.getTime()) / 60_000;
        expect(Math.round(minutes)).toBe(60);
        expect(person.page.jar[SESSION_COOKIE]).toBeTruthy();
      } finally {
        await policy({ sessionIdleMinutes: 15 });
      }
    });

    it("caps a token's lifetime, the ones made before included", async () => {
      const person = await account("Tom");
      expect(
        await code(
          person.page.call().auth.createToken({ name: "long", days: 200 }),
        ),
      ).toBe("ok");
      const token = (await createApiToken(db, person.id, "old", { days: 90 }))
        .token;
      await db
        .updateTable("apiTokens")
        .set({ createdAt: sql<Date>`now() - interval '40 days'` })
        .where("userId", "=", person.id)
        .execute();
      const asToken = () =>
        requestActor(db, { authorization: `Bearer ${token}` }, undefined);
      expect((await asToken())?.user.id).toBe(person.id);
      await policy({ tokenMaxDays: 30 });
      try {
        expect(
          await code(
            person.page.call().auth.createToken({ name: "long", days: 31 }),
          ),
        ).toBe("token_lifetime_too_long");
        // Made 40 days ago, for 90: past the 30 days it may live now.
        expect(await asToken()).toBeNull();
        const listed = await person.page.call().auth.tokens();
        const old = listed.tokens.find((item) => item.name === "old");
        expect(Date.parse(old?.expiresAt ?? "")).toBeLessThan(Date.now());
      } finally {
        await policy({ tokenMaxDays: 365 });
      }
      expect((await asToken())?.user.id).toBe(person.id);
    });
  });

  describe("public links", () => {
    it("follows the policy for new links and the ones already out", async () => {
      const base = await insertBase(db, adminId, { name: `Links ${suffix}` });
      const table = await insertTable(db, adminId, {
        baseId: base.id,
        name: "Leads",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      });
      const { id: viewId } = await db
        .selectFrom("views")
        .select("id")
        .where("tableId", "=", table.id)
        .executeTakeFirstOrThrow();
      const open = await createShare(db, {
        viewId,
        createdBy: adminId,
        allowCopy: false,
      });
      const locked = await createShare(db, {
        viewId,
        createdBy: adminId,
        allowCopy: false,
        password: "a share password",
      });
      const resolve = (token: string) =>
        code(resolveShare(db, env.AUTH_ENCRYPTION_KEY, { token }));
      expect(await resolve(open.token)).toBe("ok");

      await policy({ publicLinks: "password" });
      try {
        expect(await resolve(open.token)).toBe("unknown_share");
        expect(await resolve(locked.token)).toBe("ok");
        expect(
          await code(
            createShare(db, { viewId, createdBy: adminId, allowCopy: false }),
          ),
        ).toBe("share_password_required");
        await policy({ publicLinks: "off" });
        expect(await resolve(locked.token)).toBe("unknown_share");
        expect(
          await code(
            createShare(db, {
              viewId,
              createdBy: adminId,
              allowCopy: false,
              password: "a share password",
            }),
          ),
        ).toBe("public_links_disabled");
      } finally {
        await policy({ publicLinks: "allowed" });
      }
      expect(await resolve(open.token)).toBe("ok");
    });

    it("locks a link after ten wrong passwords", async () => {
      const base = await insertBase(db, adminId, { name: `Lock ${suffix}` });
      const table = await insertTable(db, adminId, {
        baseId: base.id,
        name: "Leads",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      });
      const { id: viewId } = await db
        .selectFrom("views")
        .select("id")
        .where("tableId", "=", table.id)
        .executeTakeFirstOrThrow();
      const share = await createShare(db, {
        viewId,
        createdBy: adminId,
        allowCopy: false,
        password: "a share password",
      });
      const open = (password?: string) =>
        resolveShare(db, env.AUTH_ENCRYPTION_KEY, {
          token: share.token,
          password,
        });
      const opened = await open();
      expect(opened.locked).toBe(true);
      const granted = await open("a share password");
      for (let attempt = 0; attempt < 9; attempt += 1) {
        expect((await open("wrong password")).locked).toBe(true);
      }
      expect(await code(open("wrong password"))).toBe("share_locked");
      expect(await code(open("a share password"))).toBe("share_locked");
      expect(await code(open())).toBe("share_locked");
      // The lock stops guesses, not someone who already gave the password.
      const reading = await resolveShare(db, env.AUTH_ENCRYPTION_KEY, {
        token: share.token,
        access: granted.access ?? undefined,
      });
      expect(reading.locked).toBe(false);
      await db
        .updateTable("shares")
        .set({ passwordLockedUntil: new Date(Date.now() - 1000) })
        .where("id", "=", share.id)
        .execute();
      const again = await open("a share password");
      expect(again.locked).toBe(false);
      expect(again.access).toEqual(expect.any(String));
    });
  });

  describe("a link's wrong passwords", () => {
    it("counts each guess, sent together or not", async () => {
      const base = await insertBase(db, adminId, { name: `Race ${suffix}` });
      const table = await insertTable(db, adminId, {
        baseId: base.id,
        name: "Leads",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      });
      const { id: viewId } = await db
        .selectFrom("views")
        .select("id")
        .where("tableId", "=", table.id)
        .executeTakeFirstOrThrow();
      const share = await createShare(db, {
        viewId,
        createdBy: adminId,
        allowCopy: false,
        password: "a share password",
      });
      await Promise.all(
        Array.from({ length: 6 }, () =>
          resolveShare(db, env.AUTH_ENCRYPTION_KEY, {
            token: share.token,
            password: "wrong password",
          }),
        ),
      );
      const counted = await db
        .selectFrom("shares")
        .select("passwordFailures")
        .where("id", "=", share.id)
        .executeTakeFirstOrThrow();
      expect(counted.passwordFailures).toBe(6);
    });
  });

  describe("an account corrected by an administrator", () => {
    const changes = (userId: string) =>
      db
        .selectFrom("authEvents")
        .select(["detail", "actorId", "method"])
        .where("action", "=", "account_updated")
        .where("userId", "=", userId)
        .orderBy("detail")
        .execute();

    it("changes the name and the address, names both in the trail, and ends the links sent to the old address", async () => {
      const person = await account("Misnamed");
      await createResetLink(db, {
        userId: person.id,
        createdBy: adminId,
        ttlMs: 60_000,
      });
      const moved = `renamed-${String(n)}-${suffix}@example.org`;
      expect(
        await updateAccount(db, adminId, {
          userId: person.id,
          displayName: "Rightly Named",
          email: moved.toUpperCase(),
        }),
      ).toEqual({ displayName: true, email: true });
      expect(
        await db
          .selectFrom("users")
          .select(["displayName", "email"])
          .where("id", "=", person.id)
          .executeTakeFirst(),
      ).toEqual({ displayName: "Rightly Named", email: moved });
      expect(await changes(person.id)).toEqual([
        { detail: "display_name", actorId: adminId, method: "admin" },
        { detail: "email", actorId: adminId, method: "admin" },
      ]);
      expect(
        await db
          .selectFrom("passwordResets")
          .select("id")
          .where("userId", "=", person.id)
          .execute(),
      ).toEqual([]);
      // The person signs in with the new address, no longer with the old.
      expect((await signIn(moved)).result).toBe("ok");
      expect((await signIn(person.email)).result).toBe("invalid_credentials");
      // Saved again as it is: nothing changes, nothing is recorded.
      expect(
        await updateAccount(db, adminId, {
          userId: person.id,
          displayName: "Rightly Named",
          email: moved,
        }),
      ).toEqual({ displayName: false, email: false });
      expect(await changes(person.id)).toHaveLength(2);
    });

    it("lets an administrator correct their own name, and keeps a link when only the name changes", async () => {
      const mine = await db
        .selectFrom("users")
        .select(["displayName", "email"])
        .where("id", "=", adminId)
        .executeTakeFirstOrThrow();
      await updateAccount(db, adminId, {
        userId: adminId,
        displayName: "Ada Lovelace",
        email: mine.email,
      });
      expect(await changes(adminId)).toEqual([
        { detail: "display_name", actorId: adminId, method: "admin" },
      ]);
      await updateAccount(db, adminId, { userId: adminId, ...mine });

      const person = await account("Keeps");
      await createResetLink(db, {
        userId: person.id,
        createdBy: adminId,
        ttlMs: 60_000,
      });
      await updateAccount(db, adminId, {
        userId: person.id,
        displayName: "Keeps The Link",
        email: person.email,
      });
      expect(
        await db
          .selectFrom("passwordResets")
          .select("id")
          .where("userId", "=", person.id)
          .execute(),
      ).toHaveLength(1);
    });

    it("refuses an address another account has, an account the identity provider keeps, and the erased account", async () => {
      const person = await account("Fixed");
      const other = await account("Taken");
      const attempt = (userId: string, email: string) =>
        code(updateAccount(db, adminId, { userId, displayName: "Any", email }));
      expect(await attempt(person.id, other.email)).toBe(
        "account_already_exists",
      );
      expect(await attempt(ERASED_USER_ID, person.email)).toBe(
        "invalid_account",
      );
      expect(
        await attempt("00000000-0000-4000-8000-000000000001", person.email),
      ).toBe("unknown_account");
      await db
        .updateTable("users")
        .set({ scimUserName: person.email, deprovisionedAt: null })
        .where("id", "=", person.id)
        .execute();
      expect(await attempt(person.id, person.email)).toBe("invalid_account");
      // Removed by the provider, the account is the instance's to correct.
      await db
        .updateTable("users")
        .set({ deprovisionedAt: new Date() })
        .where("id", "=", person.id)
        .execute();
      expect(await attempt(person.id, person.email)).toBe("ok");
      expect(await changes(other.id)).toEqual([]);
    });
  });

  describe("account erasure", () => {
    it("keeps the trail and drops the person", async () => {
      const person = await account("Erased");
      const base = await insertBase(db, person.id, { name: `Gone ${suffix}` });
      await createInvitation(db, {
        baseId: base.id,
        email: person.email,
        role: "editor",
        invitedBy: adminId,
      });
      await recordAuthEvent(db, {
        action: "login_success",
        userId: person.id,
        method: "password",
        ip: "203.0.113.10",
      });
      const table = await insertTable(db, person.id, {
        baseId: base.id,
        name: "Files",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      });
      const fileKey = `att_${suffix}`;
      await withAudit(db, { userId: person.id, source: "web" }, (tx) =>
        tx
          .insertInto("attachments")
          .values({
            key: fileKey,
            tableId: table.id,
            filename: "note.txt",
            mime: "text/plain",
            size: 1,
            createdBy: person.id,
          })
          .execute(),
      );
      const { id: commentId } = await addComment(db, {
        tableId: table.id,
        rowId: "row-1",
        authorId: person.id,
        body: "Keep this note",
      });
      // No one else owns the base: the person hands it over first.
      expect(await code(eraseAccount(db, person.id))).toBe("invalid_owner");
      await grantMember(db, person.id, {
        baseId: base.id,
        email: `admin-${suffix}@example.org`,
        role: "owner",
      });
      await eraseAccount(db, person.id);
      expect(
        await db
          .selectFrom("users")
          .select("id")
          .where("id", "=", person.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      // A file in a cell is the table's: it stays, without its author.
      expect(
        await db
          .selectFrom("attachments")
          .select("createdBy")
          .where("key", "=", fileKey)
          .executeTakeFirst(),
      ).toEqual({ createdBy: null });
      expect(
        await db
          .selectFrom("comments")
          .select(["authorId", "body"])
          .where("id", "=", commentId)
          .executeTakeFirst(),
      ).toEqual({ authorId: ERASED_USER_ID, body: "Keep this note" });
      expect(
        await db
          .selectFrom("auditEvents")
          .select("userId")
          .where("userId", "=", person.id)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom("auditEvents")
          .select("userId")
          .where("userId", "=", ERASED_USER_ID)
          .executeTakeFirst(),
      ).toEqual({ userId: ERASED_USER_ID });
      expect(
        await db
          .selectFrom("invitations")
          .select("email")
          .where("email", "=", person.email)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom("authEvents")
          .select("ip")
          .where("ip", "=", "203.0.113.10")
          .execute(),
      ).toEqual([]);
      expect(await code(eraseAccount(db, ERASED_USER_ID))).toBe(
        "invalid_account",
      );
    });

    it("keeps the account erased people become out of reach", async () => {
      expect(await code(otherAccount(db, adminId, ERASED_USER_ID))).toBe(
        "invalid_account",
      );
      expect(
        await code(setUserDisabled(db, adminId, ERASED_USER_ID, false)),
      ).toBe("invalid_account");
      expect(await code(setUserAdmin(db, ERASED_USER_ID, true))).toBe(
        "invalid_account",
      );
      expect(await accessReportCsv(db)).not.toContain("users.invalid");
      const listed = await listUsers(db, {
        search: "users.invalid",
        offset: 0,
        limit: 10,
      });
      expect(listed.users).toEqual([]);
    });

    it("lets an administrator erase a disabled account after typing its email", async () => {
      const person = await account("AdminErase");
      await setUserDisabled(db, adminId, person.id, true);
      const info = await eraseInfo(db, adminId, person.id);
      expect(info).toMatchObject({
        email: person.email,
        disabled: true,
        provisioned: false,
        soleOwnerBases: [],
      });
      await eraseOtherAccount(db, adminId, {
        userId: person.id,
        email: person.email.toUpperCase(),
      });
      expect(
        await db
          .selectFrom("users")
          .select("id")
          .where("id", "=", person.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      // The trail keeps that an administrator erased someone; the target
      // id is cleared with the account (ON DELETE SET NULL).
      expect(
        await db
          .selectFrom("authEvents")
          .select(["action", "detail", "actorId", "userId"])
          .where("action", "=", "account_erased")
          .where("actorId", "=", adminId)
          .executeTakeFirst(),
      ).toEqual({
        action: "account_erased",
        detail: "admin_erase",
        actorId: adminId,
        userId: null,
      });
    });

    it("refuses admin erase until the account is disabled, confirmed, and free of SCIM", async () => {
      const person = await account("Guarded");
      const attempt = (email = person.email, actorId = adminId) =>
        code(eraseOtherAccount(db, actorId, { userId: person.id, email }));
      expect(await attempt()).toBe("invalid_account");
      await setUserDisabled(db, adminId, person.id, true);
      expect(await attempt("wrong@example.org")).toBe("invalid_account");
      expect(await attempt(person.email, person.id)).toBe("invalid_account");
      // Still kept by the identity provider.
      await db
        .updateTable("users")
        .set({ scimUserName: person.email, deprovisionedAt: null })
        .where("id", "=", person.id)
        .execute();
      expect((await eraseInfo(db, adminId, person.id)).provisioned).toBe(true);
      expect(await attempt()).toBe("invalid_account");
      // Removed by the provider: it keeps its name there, and may go here.
      await db
        .updateTable("users")
        .set({ deprovisionedAt: new Date() })
        .where("id", "=", person.id)
        .execute();
      expect((await eraseInfo(db, adminId, person.id)).provisioned).toBe(false);
      expect(await attempt()).toBe("ok");
      expect(
        await db
          .selectFrom("users")
          .select("id")
          .where("id", "=", person.id)
          .executeTakeFirst(),
      ).toBeUndefined();
    });

    it("hands the bases an erased account alone owned to the account the administrator names", async () => {
      const person = await account("Leaving");
      const heir = await account("Heir");
      const idle = await account("Idle");
      await setUserDisabled(db, adminId, idle.id, true);
      const soleName = `Sole ${suffix}-${String(n)}`;
      const base = await insertBase(db, person.id, { name: soleName });
      await setUserDisabled(db, adminId, person.id, true);
      expect(await soleOwnerBases(db, person.id)).toEqual([
        { id: base.id, name: soleName },
      ]);
      const erased = () =>
        db
          .selectFrom("authEvents")
          .select("id")
          .where("action", "=", "account_erased")
          .where("actorId", "=", adminId)
          .execute();
      const before = (await erased()).length;
      const attempt = (successorEmail?: string) =>
        code(
          eraseOtherAccount(db, adminId, {
            userId: person.id,
            email: person.email,
            successorEmail,
          }),
        );
      expect(await attempt()).toBe("invalid_owner");
      expect(await attempt(`nobody-${suffix}@example.org`)).toBe(
        "unknown_account",
      );
      // Not the account itself, not a disabled one.
      expect(await attempt(person.email)).toBe("invalid_account");
      expect(await attempt(idle.email)).toBe("invalid_account");
      // A refusal writes nothing: the account, its base, and the trail are
      // as they were.
      expect((await erased()).length).toBe(before);
      expect(await soleOwnerBases(db, person.id)).toEqual([
        { id: base.id, name: soleName },
      ]);
      expect(await attempt(heir.email.toUpperCase())).toBe("ok");
      expect((await erased()).length).toBe(before + 1);
      expect(
        await db
          .selectFrom("roleBindings")
          .select(["userId", "role"])
          .where("scope", "=", "base")
          .where("scopeId", "=", base.id)
          .execute(),
      ).toEqual([{ userId: heir.id, role: "owner" }]);
      // The hand-over is the administrator's act in the base's audit.
      expect(
        await db
          .selectFrom("auditEvents")
          .select("userId")
          .where("action", "=", "catalog")
          .where("userId", "=", adminId)
          .where(
            sql<boolean>`new_value ->> 'scope_id' = ${base.id} and new_value ->> 'user_id' = ${heir.id}`,
          )
          .execute(),
      ).toHaveLength(1);
    });

    it("lets the administrator take the bases themselves", async () => {
      const person = await account("Alone");
      const base = await insertBase(db, person.id, {
        name: `Alone ${suffix}-${String(n)}`,
      });
      await setUserDisabled(db, adminId, person.id, true);
      await eraseOtherAccount(db, adminId, {
        userId: person.id,
        email: person.email,
        successorEmail: `admin-${suffix}@example.org`,
      });
      expect(
        await db
          .selectFrom("roleBindings")
          .select(["userId", "role"])
          .where("scope", "=", "base")
          .where("scopeId", "=", base.id)
          .execute(),
      ).toEqual([{ userId: adminId, role: "owner" }]);
    });

    it("keeps an active administrator on the instance", async () => {
      // Administrators left by earlier tests step down for this one.
      const others = await db
        .selectFrom("users")
        .select("id")
        .where("isAdmin", "=", true)
        .where("disabledAt", "is", null)
        .where("id", "<>", adminId)
        .execute();
      const stepped = others.map((other) => other.id);
      if (stepped.length > 0) {
        await db
          .updateTable("users")
          .set({ isAdmin: false })
          .where("id", "in", stepped)
          .execute();
      }
      try {
        expect(await code(eraseAccount(db, adminId))).toBe("invalid_account");
        const second = await account("Second");
        await setUserAdmin(db, second.id, true);
        await eraseAccount(db, second.id);
        expect(
          await db
            .selectFrom("users")
            .select("id")
            .where("id", "=", second.id)
            .executeTakeFirst(),
        ).toBeUndefined();
        expect(await code(eraseAccount(db, adminId))).toBe("invalid_account");
      } finally {
        if (stepped.length > 0) {
          await db
            .updateTable("users")
            .set({ isAdmin: true })
            .where("id", "in", stepped)
            .execute();
        }
      }
    });
  });

  describe("sign-up domains", () => {
    it("takes only the listed domains, but an invitation still lets in", async () => {
      await policy({ signupDomains: ["Example.org"] });
      try {
        expect(
          await code(
            browser()
              .call()
              .auth.signup({
                email: `out-${suffix}@elsewhere.test`,
                displayName: "Out",
                password: PASSWORD,
              }),
          ),
        ).toBe("signup_domain_not_allowed");
        // A listed domain: the sign-up waits for its mailed link.
        expect(
          await browser()
            .call()
            .auth.signup({
              email: `inside-${suffix}@example.org`,
              displayName: "Inside",
              password: PASSWORD,
            }),
        ).toEqual({ status: "verify" });
        const base = await insertBase(db, adminId, {
          name: `Guests ${suffix}`,
        });
        const invitation = await createInvitation(db, {
          baseId: base.id,
          email: `guest-${suffix}@elsewhere.test`,
          role: "viewer",
          invitedBy: adminId,
        });
        // Invited, from outside the domains: in at once, from its link.
        expect(
          await browser()
            .call()
            .auth.signup({
              email: `guest-${suffix}@elsewhere.test`,
              displayName: "Guest",
              password: PASSWORD,
              invitation: invitation.token,
            }),
        ).toEqual({ status: "session" });
      } finally {
        await policy({ signupDomains: [] });
      }
    });
  });

  describe("the trail", () => {
    it("names who changed which setting, not the value", async () => {
      const changes = () =>
        db
          .selectFrom("authEvents")
          .select(["actorId", "detail", "method"])
          .where("action", "=", "settings_changed")
          .where("detail", "=", "lockoutThreshold")
          .execute();
      const before = (await changes()).length;
      await policy({ lockoutThreshold: 7 });
      // The same value again is no change.
      await policy({ lockoutThreshold: 7 });
      await policy({ lockoutThreshold: 10 });
      const after = await changes();
      expect(after.length - before).toBe(2);
      expect(
        after.every(
          (event) => event.actorId === adminId && event.method === "admin",
        ),
      ).toBe(true);
    });

    it("keeps events six months to a year, as the instance says", async () => {
      await db
        .insertInto("authEvents")
        .values([
          {
            action: "login_success",
            occurredAt: sql<Date>`now() - interval '200 days'`,
          },
          {
            action: "login_success",
            occurredAt: sql<Date>`now() - interval '100 days'`,
          },
        ])
        .execute();
      expect(await purgeAuthEvents(db, 365)).toBe(0);
      expect(await purgeAuthEvents(db, 180)).toBe(1);
      // Younger than six months: the table refuses, whatever is asked.
      await expect(
        db
          .deleteFrom("authEvents")
          .where("occurredAt", "<", sql<Date>`now() - interval '90 days'`)
          .execute(),
      ).rejects.toThrow(/append-only/);
    });
  });
  describe("who creates, whom owners invite, idle accounts, lock alerts (ADR 0044)", () => {
    it("keeps base creation to administrators when asked", async () => {
      const owner = await account("Bea");
      await enrollTotp(owner.page);
      expect(
        await code(owner.page.call().catalog.createBase({ name: "Before" })),
      ).toBe("ok");
      await policy({ baseCreation: "admins" });
      try {
        expect(
          await code(owner.page.call().catalog.createBase({ name: "After" })),
        ).toBe("base_creation_restricted");
        expect(
          (await owner.page.call().session.current())?.canCreateBases,
        ).toBe(false);
        // Their bases stay theirs; administrators still create.
        expect(await code(owner.page.call().catalog.list())).toBe("ok");
        expect(
          await code(
            admin.call().catalog.createBase({ name: `Adm ${suffix}` }),
          ),
        ).toBe("ok");
      } finally {
        await policy({ baseCreation: "everyone" });
      }
    });

    it("keeps API tokens to administrators, the ones made before included", async () => {
      const person = await account("Theo");
      const made = await person.page
        .call()
        .auth.createToken({ name: "script" });
      const asToken = (token: string) =>
        requestActor(db, { authorization: `Bearer ${token}` }, undefined);
      expect((await asToken(made.token))?.user.id).toBe(person.id);
      const adminToken = (await createApiToken(db, adminId, "ops")).token;
      await policy({ apiTokens: "admins" });
      try {
        expect(
          await code(person.page.call().auth.createToken({ name: "more" })),
        ).toBe("api_tokens_restricted");
        expect(await asToken(made.token)).toBeNull();
        expect((await asToken(adminToken))?.user.id).toBe(adminId);
        expect(
          (await person.page.call().session.current())?.canCreateTokens,
        ).toBe(false);
      } finally {
        await policy({ apiTokens: "everyone" });
      }
      expect((await asToken(made.token))?.user.id).toBe(person.id);
    });

    it("refuses a token on account changes, and a password to replace a factor", async () => {
      const person = await account("Nia");
      const full = await person.page.call().auth.createToken({ name: "full" });
      const limited = await person.page
        .call()
        .auth.createToken({ name: "read", readOnly: true });
      const ceremony = {
        id: "aa",
        rawId: "aa",
        type: "public-key" as const,
        clientExtensionResults: {},
        response: { clientDataJSON: "aa", attestationObject: "aa" },
      };
      for (const token of [full.token, limited.token]) {
        const caller = person.page.call({
          authorization: `Bearer ${token}`,
        });
        expect(await code(caller.auth.createToken({ name: "wider" }))).toBe(
          "access_denied",
        );
        expect(await code(caller.auth.revokeToken({ tokenId: full.id }))).toBe(
          "access_denied",
        );
        expect(await code(caller.auth.totp.begin())).toBe("access_denied");
        expect(
          await code(
            caller.auth.totp.confirm({
              secret: "JBSWY3DPEHPK3PXP",
              code: "000000",
            }),
          ),
        ).toBe("access_denied");
        expect(await code(caller.auth.webauthn.registerBegin())).toBe(
          "access_denied",
        );
        expect(await code(caller.auth.webauthn.registerFinish(ceremony))).toBe(
          "access_denied",
        );
      }
      await enrollTotp(person.page);
      const begun = await person.page.call().auth.totp.begin();
      const fresh = totpCode(decodeBase32(begun.secret), Date.now());
      expect(
        await code(
          person.page.call().auth.totp.confirm({
            secret: begun.secret,
            code: fresh,
          }),
        ),
      ).toBe("invalid_credentials");
      expect(
        await code(
          person.page.call().auth.totp.confirm({
            secret: begun.secret,
            code: fresh,
            password: PASSWORD,
          }),
        ),
      ).toBe("ok");
      // A passkey asks for the proof once, to begin its ceremony.
      const passkey = person.page.call().auth.webauthn;
      expect(await code(passkey.registerBegin())).toBe("invalid_credentials");
      expect(
        await code(passkey.registerBegin({ password: "not the password" })),
      ).toBe("invalid_credentials");
      expect(await code(passkey.registerFinish(ceremony))).toBe(
        "challenge_expired",
      );
      expect(await code(passkey.registerBegin({ password: PASSWORD }))).toBe(
        "ok",
      );
    });

    it("keeps invitations to the sign-up domains when asked, pending ones included", async () => {
      const base = await insertBase(db, adminId, { name: `Team ${suffix}` });
      const outside = `partner-${suffix}@elsewhere.test`;
      const pending = await admin.call().catalog.invite({
        baseId: base.id,
        email: outside,
        role: "viewer",
      });
      // An account outside the domains, made before.
      await db
        .insertInto("users")
        .values({ email: `known-${suffix}@elsewhere.test`, displayName: "K" })
        .execute();
      await policy({ signupDomains: ["example.org"], invitations: "domains" });
      try {
        expect(
          await code(
            admin.call().catalog.invite({
              baseId: base.id,
              email: `other-${suffix}@elsewhere.test`,
              role: "viewer",
            }),
          ),
        ).toBe("invitation_domain_not_allowed");
        expect(
          await code(
            admin.call().catalog.grant({
              baseId: base.id,
              email: `known-${suffix}@elsewhere.test`,
              role: "viewer",
            }),
          ),
        ).toBe("invitation_domain_not_allowed");
        expect(
          await code(
            admin.call().catalog.invite({
              baseId: base.id,
              email: `colleague-${suffix}@example.org`,
              role: "editor",
            }),
          ),
        ).toBe("ok");
        // The invitation sent before no longer lets its address sign up.
        expect(
          await code(
            browser().call().auth.signup({
              email: outside,
              displayName: "Partner",
              password: PASSWORD,
            }),
          ),
        ).toBe("signup_domain_not_allowed");
      } finally {
        await policy({ signupDomains: [], invitations: "anyone" });
      }
      // Back to any address, it works again.
      const partner = browser();
      await partner.call().auth.signup({
        email: outside,
        displayName: "Partner",
        password: PASSWORD,
        invitation: pending.token ?? "",
      });
      expect(
        await code(
          partner.call().auth.acceptInvitation({ token: pending.token ?? "" }),
        ),
      ).toBe("ok");
    });

    it("refuses a pending invitation once invitations keep to the domains", async () => {
      const base = await insertBase(db, adminId, { name: `Late ${suffix}` });
      const email = `late-${suffix}@elsewhere.test`;
      const guest = browser();
      await signUpProved(guest, db, {
        email,
        displayName: "Late",
        password: PASSWORD,
      });
      // Sent while any address could be invited.
      const invitation = await createInvitation(db, {
        baseId: base.id,
        email,
        role: "viewer",
        invitedBy: adminId,
      });
      await policy({ signupDomains: ["example.org"], invitations: "domains" });
      try {
        expect(
          await code(
            guest.call().auth.acceptInvitation({ token: invitation.token }),
          ),
        ).toBe("invitation_domain_not_allowed");
      } finally {
        await policy({ signupDomains: [], invitations: "anyone" });
      }
      expect(
        await code(
          guest.call().auth.acceptInvitation({ token: invitation.token }),
        ),
      ).toBe("ok");
    });

    describe("idle accounts", () => {
      const deps = () => ({
        db,
        env,
        log: { error: vi.fn() },
      });
      const idle = async (name: string, days: number, patch = {}) => {
        const person = await account(name);
        await db
          .updateTable("users")
          .set({
            activeAt: sql<Date>`now() - make_interval(days => ${days})`,
            ...patch,
          })
          .where("id", "=", person.id)
          .execute();
        return person;
      };
      const state = (id: string) =>
        db
          .selectFrom("users")
          .select(["disabledAt", "disabledReason", "inactivityWarnedAt"])
          .where("id", "=", id)
          .executeTakeFirstOrThrow();

      it("never disables anyone while the policy is off", async () => {
        const old = await idle("Old", 900);
        expect(await sweepInactiveAccounts(deps())).toEqual({
          warned: 0,
          disabled: 0,
        });
        expect((await state(old.id)).disabledAt).toBeNull();
      });

      it("warns a week before, then disables, and leaves administrators and SCIM alone", async () => {
        await policy({ inactiveDays: 30 });
        try {
          const quiet = await idle("Quiet", 40);
          const boss = await idle("Boss", 400, { isAdmin: true });
          const kept = await idle("Kept", 400, {
            scimUserName: `kept-${suffix}`,
          });
          const busy = await account("Busy");
          // Turned on: warned first, even past the delay.
          const first = await sweepInactiveAccounts(deps());
          expect(first.disabled).toBe(0);
          expect((await state(quiet.id)).inactivityWarnedAt).not.toBeNull();
          expect(mailText(await smtp.next(quiet.email))).toContain(
            "Unless you sign in by",
          );
          // Warned once.
          await sweepInactiveAccounts(deps());
          expect(
            smtp.received.some((mail) => mail.to.includes(quiet.email)),
          ).toBe(false);
          // A week later, still idle: disabled.
          await db
            .updateTable("users")
            .set({ inactivityWarnedAt: sql<Date>`now() - interval '8 days'` })
            .where("id", "=", quiet.id)
            .execute();
          expect((await sweepInactiveAccounts(deps())).disabled).toBe(1);
          expect(await state(quiet.id)).toMatchObject({
            disabledReason: "inactive",
          });
          expect(mailText(await smtp.next(quiet.email))).toContain(
            "was not used for 30 days",
          );
          expect(await code(quiet.page.call().catalog.list())).toBe(
            "UNAUTHORIZED",
          );
          const events = await trail(quiet.id);
          expect(events.at(-1)).toMatchObject({
            action: "account_disabled",
            detail: "inactive",
          });
          for (const other of [boss, kept, busy]) {
            expect((await state(other.id)).disabledAt).toBeNull();
          }
          const listed = await admin
            .call()
            .admin.users({ search: quiet.email });
          expect(listed.users[0]?.disabledReason).toBe("inactive");
          // Enabled again: the count starts over.
          await admin
            .call()
            .admin.setDisabled({ userId: quiet.id, disabled: false });
          await sweepInactiveAccounts(deps());
          expect(await state(quiet.id)).toMatchObject({
            disabledAt: null,
            disabledReason: null,
            inactivityWarnedAt: null,
          });
        } finally {
          await policy({ inactiveDays: 0 });
        }
      });

      it("starts over on a sign-in", async () => {
        await policy({ inactiveDays: 30 });
        try {
          const back = await idle("Back", 28);
          await sweepInactiveAccounts(deps());
          expect((await state(back.id)).inactivityWarnedAt).not.toBeNull();
          expect((await signIn(back.email)).result).toBe("ok");
          expect((await state(back.id)).inactivityWarnedAt).toBeNull();
        } finally {
          await policy({ inactiveDays: 0 });
        }
      });

      it("disables without warning when no email can warn", async () => {
        await policy({ inactiveDays: 30 });
        const host = env.SMTP_HOST;
        delete env.SMTP_HOST;
        try {
          const gone = await idle("Gone", 31);
          expect(
            (await sweepInactiveAccounts(deps())).disabled,
          ).toBeGreaterThanOrEqual(1);
          expect((await state(gone.id)).disabledReason).toBe("inactive");
        } finally {
          env.SMTP_HOST = host;
          await policy({ inactiveDays: 0 });
        }
      });
    });

    describe("lock alerts", () => {
      const lockedCount = async () =>
        (
          await db
            .selectFrom("authEvents")
            .select(sql<number>`count(*)::int`.as("count"))
            .where("action", "=", "account_locked")
            .where("occurredAt", ">", sql<Date>`now() - interval '1 hour'`)
            .executeTakeFirstOrThrow()
        ).count;
      const lock = async (name: string) => {
        const target = await account(name);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await signIn(target.email, "wrong password here");
        }
        return target;
      };
      const alerts = async () =>
        (
          await admin.call().notifications.list({ limit: 50 })
        ).notifications.filter((item) => item.kind === "account_locked");

      beforeAll(async () => {
        await policy({ lockoutThreshold: 3 });
      });

      it("tells administrators in the app and by email", async () => {
        // Under the hourly cap for this test.
        expect(await lockedCount()).toBeLessThan(10);
        const before = (await alerts()).length;
        const target = await lock("Alma");
        const now = await alerts();
        expect(now.length).toBe(before + 1);
        expect(now[0]?.data).toMatchObject({ name: "Alma", userId: target.id });
        const mail = mailText(await smtp.next(`admin-${suffix}@example.org`));
        expect(mail).toContain("Alma's account");
        expect(mail).toContain("after 3 failed attempts");
      });

      it("stays quiet when turned off", async () => {
        await policy({ lockAlerts: false });
        try {
          const before = (await alerts()).length;
          await lock("Quinn");
          expect((await alerts()).length).toBe(before);
        } finally {
          await policy({ lockAlerts: true });
        }
      });

      it("says once that many accounts lock, then waits for the trail", async () => {
        // Fill the hour up to the cap, as a run over many accounts would.
        const missing = 10 - (await lockedCount());
        if (missing > 0) {
          await db
            .insertInto("authEvents")
            .values(
              Array.from({ length: missing }, () => ({
                action: "account_locked" as const,
              })),
            )
            .execute();
        }
        const before = (await alerts()).length;
        await lock("Eleven");
        const after = await alerts();
        expect(after.length).toBe(before + 1);
        expect(after[0]?.data).toEqual({ many: "1" });
        await lock("Twelve");
        expect((await alerts()).length).toBe(before + 1);
      });
    });
  });
});
