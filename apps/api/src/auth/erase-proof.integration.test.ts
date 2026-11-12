/**
 * Deleting one's own account asks the proof a sensitive action asks: the
 * password and the authenticator's code when the account has them, a
 * recent sign-in where neither can be asked, and never an API token.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  nextTotp,
  signUpProved,
} from "../trpc/caller.test-helpers.js";
import { FRESH_SIGN_IN_MS } from "./erase-proof.js";
import { SESSION_COOKIE, createSession } from "./session.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("deleting one's own account", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });

  const account = (email: string) =>
    db
      .selectFrom("users")
      .select(["id", "failedSignIns"])
      .where("email", "=", email)
      .executeTakeFirst();

  beforeAll(async () => {
    const created = await createTestDatabase("erase-proof");
    db = created.db;
    close = created.close;
    // The instance's administrator: the accounts below are ordinary ones.
    await browser()
      .call()
      .auth.signup({
        email: `admin-${suffix}@example.org`,
        displayName: "Admin",
        password: PASSWORD,
      });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("asks the password, counts a wrong one, and never takes a token", async () => {
    const email = `carol-${suffix}@example.org`;
    const carol = browser();
    await signUpProved(carol, db, {
      email,
      displayName: "Carol",
      password: PASSWORD,
    });
    // Nothing given: refused, and nothing was guessed.
    expect(await errorCode(carol.call().auth.erase({}))).toBe(
      "invalid_credentials",
    );
    expect((await account(email))?.failedSignIns).toBe(0);
    // A guess counts toward the lock, as one at sign-in does.
    expect(
      await errorCode(
        carol.call().auth.erase({ password: "not the password at all" }),
      ),
    ).toBe("invalid_credentials");
    expect((await account(email))?.failedSignIns).toBe(1);

    // Her token, with the right password: a token does not act on the account.
    const { token } = await carol.call().auth.createToken({ name: "script" });
    expect(
      await errorCode(
        browser()
          .call({ authorization: `Bearer ${token}` })
          .auth.erase({ password: PASSWORD }),
      ),
    ).toBe("access_denied");
    expect(await account(email)).toBeDefined();

    await carol.call().auth.erase({ password: PASSWORD });
    expect(await account(email)).toBeUndefined();
  });

  it("asks the authenticator's code too when the account has one", async () => {
    const email = `dave-${suffix}@example.org`;
    const dave = browser();
    await signUpProved(dave, db, {
      email,
      displayName: "Dave",
      password: PASSWORD,
    });
    const secret = await enrollTotp(dave);
    expect(
      await errorCode(dave.call().auth.erase({ password: PASSWORD })),
    ).toBe("invalid_credentials");
    expect((await account(email))?.failedSignIns).toBe(0);
    expect(
      await errorCode(
        dave.call().auth.erase({ password: PASSWORD, factorCode: "000000" }),
      ),
    ).toBe("invalid_credentials");
    expect((await account(email))?.failedSignIns).toBe(1);

    await dave
      .call()
      .auth.erase({ password: PASSWORD, factorCode: nextTotp(secret) });
    expect(await account(email)).toBeUndefined();
  });

  it("takes a recent sign-in for an account that has no password", async () => {
    // As an account its identity provider signs in: no password here.
    const email = `erin-${suffix}@example.org`;
    const { id } = await db
      .insertInto("users")
      .values({ email, displayName: "Erin" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const erin = browser();
    erin.jar[SESSION_COOKIE] = (await createSession(db, id)).token;

    // Signed in too long ago: sign in again.
    await db
      .updateTable("sessions")
      .set({ createdAt: new Date(Date.now() - FRESH_SIGN_IN_MS - 60_000) })
      .where("userId", "=", id)
      .execute();
    expect(await errorCode(erin.call().auth.erase({}))).toBe(
      "fresh_sign_in_required",
    );
    expect(await account(email)).toBeDefined();

    await db
      .updateTable("sessions")
      .set({ createdAt: new Date() })
      .where("userId", "=", id)
      .execute();
    await erin.call().auth.erase({});
    expect(await account(email)).toBeUndefined();
  });

  it("takes no guess from a locked account", async () => {
    const email = `frank-${suffix}@example.org`;
    const frank = browser();
    await signUpProved(frank, db, {
      email,
      displayName: "Frank",
      password: PASSWORD,
    });
    await db
      .updateTable("users")
      .set({ lockedAt: new Date(), failedSignIns: 10 })
      .where("email", "=", email)
      .execute();
    expect(
      await errorCode(frank.call().auth.erase({ password: PASSWORD })),
    ).toBe("account_locked");
    expect(await account(email)).toBeDefined();
  });
});
