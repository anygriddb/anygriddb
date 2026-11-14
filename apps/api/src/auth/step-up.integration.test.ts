/**
 * Administration step-up (ROADMAP #28): a fresh password or second factor
 * before sensitive actions, stamped on the session for five minutes.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "./key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  nextTotp,
  signUpProved,
  type TestBrowser,
} from "../trpc/caller.test-helpers.js";
import { FRESH_STEP_UP_MS } from "./step-up.js";
import { hashSessionToken, SESSION_COOKIE } from "./session.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("administration step-up", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin: TestBrowser;
  let adminSecret: string;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });

  beforeAll(async () => {
    const created = await createTestDatabase("step-up");
    db = created.db;
    close = created.close;
    admin = browser();
    await admin.call().auth.signup({
      email: `admin-${suffix}@example.org`,
      displayName: "Admin",
      password: PASSWORD,
    });
    adminSecret = await enrollTotp(admin);
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("refuses a sensitive action until stepped up, then accepts for five minutes", async () => {
    const personId = await signUpProved(browser(), db, {
      email: `person-${suffix}@example.org`,
      displayName: "Person",
      password: PASSWORD,
    });

    expect(
      await errorCode(
        admin.call().admin.setAdmin({ userId: personId, admin: true }),
      ),
    ).toBe("step_up_required");
    // An account made as an administrator is the same gift, by another
    // door; so is any account: every change asks (ADR 0073).
    expect(
      await errorCode(
        admin.call().admin.createAccount({
          email: `second-${suffix}@example.org`,
          displayName: "Second",
          admin: true,
        }),
      ),
    ).toBe("step_up_required");
    expect(
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", `second-${suffix}@example.org`)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await errorCode(
        admin.call().admin.createAccount({
          email: `plain-${suffix}@example.org`,
          displayName: "Plain",
        }),
      ),
    ).toBe("step_up_required");

    expect(await errorCode(admin.call().admin.stepUp({}))).toBe(
      "invalid_credentials",
    );
    expect(
      await errorCode(
        admin.call().admin.stepUp({ password: "not the password" }),
      ),
    ).toBe("invalid_credentials");

    await admin.call().admin.stepUp({ password: PASSWORD });
    expect((await admin.call().admin.stepUpStatus()).fresh).toBe(true);

    await admin.call().admin.setAdmin({ userId: personId, admin: true });
    expect(
      (
        await db
          .selectFrom("users")
          .select("isAdmin")
          .where("id", "=", personId)
          .executeTakeFirstOrThrow()
      ).isAdmin,
    ).toBe(true);
    await admin.call().admin.createAccount({
      email: `second-${suffix}@example.org`,
      displayName: "Second",
      admin: true,
    });
    expect(
      (
        await db
          .selectFrom("users")
          .select("isAdmin")
          .where("email", "=", `second-${suffix}@example.org`)
          .executeTakeFirstOrThrow()
      ).isAdmin,
    ).toBe(true);

    // Age the stamp past the window: the next grant asks again.
    const token = admin.jar[SESSION_COOKIE];
    expect(token).toBeTruthy();
    await db
      .updateTable("sessions")
      .set({
        steppedUpAt: new Date(Date.now() - FRESH_STEP_UP_MS - 60_000),
      })
      .where("tokenHash", "=", hashSessionToken(token ?? ""))
      .execute();
    expect((await admin.call().admin.stepUpStatus()).fresh).toBe(false);
    expect(
      await errorCode(
        admin.call().admin.setAdmin({ userId: personId, admin: true }),
      ),
    ).toBe("step_up_required");
    // Taking administration away asks the same proof once the stamp ages.
    expect(
      await errorCode(
        admin.call().admin.setAdmin({ userId: personId, admin: false }),
      ),
    ).toBe("step_up_required");
    expect(
      await errorCode(
        admin.call().admin.updateSettings({ maintenance: false }),
      ),
    ).toBe("step_up_required");

    // Authenticator code also proves the step-up for this account.
    await admin.call().admin.stepUp({ factorCode: nextTotp(adminSecret) });
    expect((await admin.call().admin.stepUpStatus()).fresh).toBe(true);
    await admin.call().admin.setAdmin({ userId: personId, admin: false });
    expect(
      (
        await db
          .selectFrom("users")
          .select("isAdmin")
          .where("id", "=", personId)
          .executeTakeFirstOrThrow()
      ).isAdmin,
    ).toBe(false);
  });

  it("takes no more guesses once wrong proofs locked the account", async () => {
    const guesser = browser();
    const guesserId = await signUpProved(guesser, db, {
      email: `guesser-${suffix}@example.org`,
      displayName: "Guesser",
      password: PASSWORD,
    });
    await db
      .updateTable("users")
      .set({ isAdmin: true })
      .where("id", "=", guesserId)
      .execute();
    await enrollTotp(guesser);
    // Ten wrong passwords lock the account, as ten at sign-in would.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        await errorCode(
          guesser.call().admin.stepUp({ password: `wrong ${String(attempt)}` }),
        ),
      ).toBe("invalid_credentials");
    }
    // The right one comes too late: the lock answers, not the password.
    expect(
      await errorCode(guesser.call().admin.stepUp({ password: PASSWORD })),
    ).toBe("account_locked");
    expect((await guesser.call().admin.stepUpStatus()).fresh).toBe(false);
  });

  it("never takes an API token for a step-up", async () => {
    const { token } = await admin.call().auth.createToken({ name: "script" });
    expect(
      await errorCode(
        browser()
          .call({ authorization: `Bearer ${token}` })
          .admin.stepUp({ password: PASSWORD }),
      ),
    ).toBe("access_denied");
  });

  it("writes administration and support, given or taken away, on the sign-in trail", async () => {
    const adminId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", `admin-${suffix}@example.org`)
        .executeTakeFirstOrThrow()
    ).id;
    const personId = await signUpProved(browser(), db, {
      email: `trailed-${suffix}@example.org`,
      displayName: "Trailed",
      password: PASSWORD,
    });
    const told = (detail: string) =>
      db
        .selectFrom("authEvents")
        .select(["actorId", "method"])
        .where("action", "=", "account_updated")
        .where("userId", "=", personId)
        .where("detail", "=", detail)
        .execute();
    await admin.call().admin.stepUp({ password: PASSWORD });

    await admin.call().admin.setAdmin({ userId: personId, admin: true });
    expect(await told("admin_granted")).toEqual([
      { actorId: adminId, method: "admin" },
    ]);
    // Given again, nothing changed: the trail is told once.
    await admin.call().admin.setAdmin({ userId: personId, admin: true });
    expect(await told("admin_granted")).toHaveLength(1);
    await admin.call().admin.setAdmin({ userId: personId, admin: false });
    expect(await told("admin_revoked")).toEqual([
      { actorId: adminId, method: "admin" },
    ]);

    await admin.call().admin.setSupport({ userId: personId, support: true });
    await admin.call().admin.setSupport({ userId: personId, support: true });
    expect(await told("support_granted")).toEqual([
      { actorId: adminId, method: "admin" },
    ]);
    await admin.call().admin.setSupport({ userId: personId, support: false });
    expect(await told("support_revoked")).toHaveLength(1);

    // An id no account has is refused, and leaves nothing.
    const nobody = crypto.randomUUID();
    expect(
      await errorCode(
        admin.call().admin.setSupport({ userId: nobody, support: true }),
      ),
    ).toBe("unknown_account");
    expect(
      await errorCode(
        admin.call().admin.setAdmin({ userId: nobody, admin: true }),
      ),
    ).toBe("unknown_account");
    expect(
      await db
        .selectFrom("authEvents")
        .select("id")
        .where("userId", "=", nobody)
        .execute(),
    ).toEqual([]);
  });
});
