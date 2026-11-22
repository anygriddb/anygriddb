/**
 * "Single sign-on only" past the moment it is turned on: what a password
 * still opens, what stays open, and what can no longer be taken away.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setUserAdmin, setUserDisabled } from "../admin.js";
import type { Env } from "../env.js";
import { clearOidc, clearOidcCache } from "../integrations/oidc.js";
import { clearSaml, clearSamlCache } from "../integrations/saml.js";
import { saveInstanceSettings } from "../instance-settings.js";
import { readSettings, writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  type TestBrowser,
} from "../trpc/caller.test-helpers.js";
import type { Context } from "../trpc/context.js";
import { hashPassword } from "./argon2.js";
import { createLoginChallenge, MFA_COOKIE } from "./challenge.js";
import { keyRing } from "./key-ring.js";
import { createSession, SESSION_COOKIE } from "./session.js";
import { saveTotpSecret } from "./totp.js";
import { decodeBase32, generateTotpSecret, totpCode } from "./totp-code.js";

const suffix = randomBytes(5).toString("hex");
const PASSWORD = "correct horse battery";
const CERT_ROW = {
  id: true as const,
  entryPoint: "https://idp.example.org/sso",
  issuer: "urn:grid:test",
  idpCert: "unused",
};

const address = (label: string) =>
  `${label}-${randomBytes(3).toString("hex")}-${suffix}@example.org`;

describe("single sign-on only", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let browser: () => TestBrowser;
  let administrator: TestBrowser;
  let adminId = "";
  const key = keyRing(randomBytes(32));
  const env = {
    AUTH_ENCRYPTION_KEY: key,
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: vi.fn(),
    closeSession: vi.fn(() => 0),
    closeAllBut: vi.fn(),
    publishLocal: vi.fn(),
  } as unknown as Context["hub"];

  const deps = () => ({ db, env, closeUser: vi.fn() });
  const actor = () => ({
    id: adminId,
    ip: "203.0.113.7",
    method: "admin" as const,
  });

  const person = async (label: string, isAdmin = false) => {
    const email = address(label);
    const row = await db
      .insertInto("users")
      .values({ email, displayName: label, isAdmin })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("passwordHashes")
      .values({ userId: row.id, hash: await hashPassword(PASSWORD) })
      .execute();
    return { email, id: row.id };
  };

  const provider = async () => {
    await db
      .insertInto("instanceSaml")
      .values(CERT_ROW)
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    clearSamlCache(db);
  };

  const refusal = async (call: Promise<unknown>) => {
    try {
      await call;
      return "accepted";
    } catch (error) {
      return (
        (error as { code?: string; cause?: { code?: string } }).cause?.code ??
        (error as { code?: string }).code
      );
    }
  };

  const signIn = async (email: string, password = PASSWORD) => {
    const page = browser();
    const answer = await refusal(page.call().auth.login({ email, password }));
    return { page, answer };
  };

  beforeAll(async () => {
    const created = await createTestDatabase("sso_only");
    db = created.db;
    close = created.close;
    browser = browserFactory({ db: () => db, env, hub });
    administrator = browser();
    await administrator.signUpFirst({
      email: `first-${suffix}@example.org`,
      displayName: "First",
      password: PASSWORD,
    });
    adminId = (await administrator.call().session.current())?.id ?? "";
    await saveTotpSecret(db, adminId, generateTotpSecret(), key, 0);
    await provider();
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  afterEach(async () => {
    await writeSettings(db, adminId, { ssoOnly: false });
    await provider();
  });

  describe("what the sign-in answers", () => {
    it("says the same of a right password, a wrong one, and no account", async () => {
      const someone = await person("oracle");
      await saveInstanceSettings(deps(), actor(), { ssoOnly: true });
      const right = await signIn(someone.email);
      const wrong = await signIn(someone.email, "another password!");
      const none = await signIn(address("nobody"));
      expect(right.answer).toBe("password_sign_in_disabled");
      expect(wrong.answer).toBe(right.answer);
      expect(none.answer).toBe(right.answer);
    });

    it("counts no failure against a person it refuses", async () => {
      const someone = await person("uncounted");
      await saveInstanceSettings(deps(), actor(), { ssoOnly: true });
      await signIn(someone.email, "another password!");
      const row = await db
        .selectFrom("users")
        .select("failedSignIns")
        .where("id", "=", someone.id)
        .executeTakeFirstOrThrow();
      expect(row.failedSignIns).toBe(0);
    });

    it("gives an administrator's wrong password the same answer", async () => {
      const second = await person("admin-typo", true);
      await saveInstanceSettings(deps(), actor(), { ssoOnly: true });
      const { answer } = await signIn(second.email, "another password!");
      expect(answer).toBe("password_sign_in_disabled");
      const row = await db
        .selectFrom("users")
        .select("failedSignIns")
        .where("id", "=", second.id)
        .executeTakeFirstOrThrow();
      expect(row.failedSignIns).toBe(1);
    });

    it("still lets an administrator in", async () => {
      const second = await person("admin-in", true);
      await saveInstanceSettings(deps(), actor(), { ssoOnly: true });
      const { page } = await signIn(second.email);
      expect((await page.call().session.current())?.id).toBe(second.id);
    });
  });

  describe("a sign-in begun before it was turned on", () => {
    const code = (secret: string) => totpCode(decodeBase32(secret), Date.now());

    const begun = async (label: string, isAdmin = false) => {
      const someone = await person(label, isAdmin);
      const secret = generateTotpSecret();
      await saveTotpSecret(db, someone.id, secret, key, 0);
      const { page, answer } = await signIn(someone.email);
      expect(answer).toBe("accepted");
      expect(page.jar[MFA_COOKIE]).toBeTruthy();
      return { ...someone, page, secret };
    };

    it("does not finish with a code", async () => {
      const someone = await begun("late-totp");
      const challenge = page(someone.page);
      // Written straight in the settings: the sign-in's own check is what
      // this asks, past the one that clears what is under way.
      await writeSettings(db, adminId, { ssoOnly: true });
      expect(
        await refusal(
          challenge.auth.totp.verify({ code: code(someone.secret) }),
        ),
      ).toBe("password_sign_in_disabled");
      expect(someone.page.jar[SESSION_COOKIE]).toBeFalsy();
    });

    it("does not finish with a backup code", async () => {
      const someone = await begun("late-backup");
      await db
        .insertInto("backupCodes")
        .values({
          userId: someone.id,
          codeHash: (await import("./backup-code.js")).hashBackupCode(
            "AAAA-BBBB-CCCC",
            key,
          ),
        })
        .execute();
      await writeSettings(db, adminId, { ssoOnly: true });
      expect(
        await refusal(
          page(someone.page).auth.backup.verify({ code: "AAAA-BBBB-CCCC" }),
        ),
      ).toBe("password_sign_in_disabled");
    });

    it("is cleared when the setting is saved", async () => {
      const someone = await begun("late-cleared");
      await saveInstanceSettings(deps(), actor(), { ssoOnly: true });
      const left = await db
        .selectFrom("loginChallenges")
        .select("id")
        .where("userId", "=", someone.id)
        .execute();
      expect(left).toEqual([]);
    });

    it("lets an administrator finish", async () => {
      const someone = await begun("late-admin", true);
      await writeSettings(db, adminId, { ssoOnly: true });
      await page(someone.page).auth.totp.verify({ code: code(someone.secret) });
      expect(someone.page.jar[SESSION_COOKIE]).toBeTruthy();
    });

    it("lets a sign-in that came through the provider finish", async () => {
      const someone = await person("late-sso");
      const secret = generateTotpSecret();
      await saveTotpSecret(db, someone.id, secret, key, 0);
      const made = await createLoginChallenge(db, someone.id, {
        provider: "oidc",
      });
      const tab = browser();
      tab.jar[MFA_COOKIE] = made.token;
      await saveInstanceSettings(deps(), actor(), { ssoOnly: true });
      await tab.call().auth.totp.verify({ code: code(secret) });
      expect(tab.jar[SESSION_COOKIE]).toBeTruthy();
    });

    const page = (tab: TestBrowser) => tab.call();
  });

  describe("what was open when it was turned on", () => {
    it("ends password sessions and tokens of others, on request", async () => {
      const local = await person("open-local");
      const viaProvider = await person("open-sso");
      const second = await person("open-admin", true);
      const localTab = (await signIn(local.email)).page;
      const token = (await localTab.call().auth.createToken({ name: "t" }))
        .token;
      const ssoSession = await createSession(db, viaProvider.id, {
        provider: "oidc",
      });
      const adminTab = (await signIn(second.email)).page;
      await saveInstanceSettings(deps(), actor(), { ssoOnly: true });

      await administrator.call().admin.stepUp({ password: PASSWORD });
      const ended = await administrator.call().admin.endPasswordAccess();
      expect(ended.sessions).toBeGreaterThanOrEqual(1);
      expect(ended.tokens).toBeGreaterThanOrEqual(1);

      expect(await localTab.call().session.current()).toBeNull();
      const tokens = await db
        .selectFrom("apiTokens")
        .select("id")
        .where("userId", "=", local.id)
        .execute();
      expect(tokens).toEqual([]);
      expect(token).toBeTruthy();
      const kept = await db
        .selectFrom("sessions")
        .select("id")
        .where("userId", "=", viaProvider.id)
        .execute();
      expect(kept).toHaveLength(1);
      expect(ssoSession.token).toBeTruthy();
      expect((await adminTab.call().session.current())?.id).toBe(second.id);
    });

    it("is refused while the setting is off", async () => {
      await administrator.call().admin.stepUp({ password: PASSWORD });
      expect(
        await refusal(administrator.call().admin.endPasswordAccess()),
      ).toBe("sso_required");
    });
  });

  describe("what can no longer be taken away", () => {
    it("keeps the last provider, and lets one of two go", async () => {
      await saveInstanceSettings(deps(), actor(), { ssoOnly: true });
      expect(await refusal(clearSaml(db, env, adminId))).toBe(
        "sso_last_provider",
      );
      await db
        .insertInto("instanceOidc")
        .values({
          id: true,
          issuer: "https://idp.example.org",
          clientId: "c",
          clientSecretCiphertext: Buffer.from("x"),
          clientSecretNonce: Buffer.from("y"),
        })
        .execute();
      clearOidcCache(db);
      await clearOidc(db, env, adminId);
      expect(await refusal(clearSaml(db, env, adminId))).toBe(
        "sso_last_provider",
      );
    });

    it("lets the last provider go once the setting is off", async () => {
      await writeSettings(db, adminId, { ssoOnly: false });
      await clearSaml(db, env, adminId);
      expect(
        await db.selectFrom("instanceSaml").select("id").execute(),
      ).toEqual([]);
    });

    it("keeps the last administrator who has a password", async () => {
      const ssoAdmin = (
        await db
          .insertInto("users")
          .values({
            email: address("sso-admin"),
            displayName: "SSO admin",
            isAdmin: true,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
      const others = await db
        .selectFrom("users as u")
        .innerJoin("passwordHashes as p", "p.userId", "u.id")
        .select("u.id")
        .where("u.isAdmin", "=", true)
        .where("u.id", "<>", adminId)
        .execute();
      for (const other of others) {
        await db
          .updateTable("users")
          .set({ isAdmin: false })
          .where("id", "=", other.id)
          .execute();
      }
      await writeSettings(db, adminId, { ssoOnly: true });
      expect(await refusal(setUserAdmin(db, ssoAdmin, adminId, false))).toBe(
        "sso_last_password_admin",
      );
      expect(await refusal(setUserDisabled(db, ssoAdmin, adminId, true))).toBe(
        "sso_last_password_admin",
      );
      await writeSettings(db, adminId, { ssoOnly: false });
      await setUserAdmin(db, ssoAdmin, adminId, false);
      await setUserAdmin(db, ssoAdmin, adminId, true);
      expect((await readSettings(db)).ssoOnly).toBe(false);
    });

    it("lets one of two administrators with a password go", async () => {
      const second = await person("second-admin", true);
      await writeSettings(db, adminId, { ssoOnly: true });
      await setUserAdmin(db, adminId, second.id, false);
      const row = await db
        .selectFrom("users")
        .select("isAdmin")
        .where("id", "=", second.id)
        .executeTakeFirstOrThrow();
      expect(row.isAdmin).toBe(false);
    });
  });
});
