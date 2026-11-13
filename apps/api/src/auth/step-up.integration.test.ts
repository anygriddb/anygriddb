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

    // Authenticator code also proves the step-up for this account.
    await admin.call().admin.stepUp({ factorCode: nextTotp(adminSecret) });
    expect((await admin.call().admin.stepUpStatus()).fresh).toBe(true);
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
});
