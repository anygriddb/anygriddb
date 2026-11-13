/**
 * The hourly purge deletes what a sign-in leaves once its time is up, and
 * the date of the last sign-in stays on the account.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "./key-ring.js";
import { listUsers } from "../admin.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory } from "../trpc/caller.test-helpers.js";
import { purgeExpiredSignIns } from "./expired.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("expired sign-ins", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
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
  const email = `ada-${suffix}@example.org`;
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);

  const count = async (
    table:
      "sessions" | "oauthStates" | "loginChallenges" | "webauthnChallenges",
  ) => (await db.selectFrom(table).select("id").execute()).length;

  beforeAll(async () => {
    const created = await createTestDatabase("expired");
    db = created.db;
    close = created.close;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("deletes what has expired, and the last sign-in stays on the account", async () => {
    // The instance's first account: signed in at once.
    await browser().call().auth.signup({
      email,
      displayName: "Ada",
      password: PASSWORD,
    });
    const account = await db
      .selectFrom("users")
      .select(["id", "lastSignInAt"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    expect(account.lastSignInAt).toBeInstanceOf(Date);

    // Its session runs out; so do an attempt at single sign-on, a second
    // step and a passkey ceremony nobody finished.
    await db.updateTable("sessions").set({ expiresAt: past }).execute();
    const state = (expiresAt: Date) => ({
      kind: "oidc",
      stateHash: randomBytes(32).toString("hex"),
      verifierCiphertext: randomBytes(16),
      verifierNonce: randomBytes(12),
      expiresAt,
    });
    await db.insertInto("oauthStates").values(state(past)).execute();
    await db
      .insertInto("loginChallenges")
      .values({
        userId: account.id,
        tokenHash: randomBytes(32).toString("hex"),
        expiresAt: past,
      })
      .execute();
    await db
      .insertInto("webauthnChallenges")
      .values({
        userId: account.id,
        challenge: randomBytes(16).toString("base64url"),
        kind: "authenticate",
        expiresAt: past,
      })
      .execute();

    expect(await purgeExpiredSignIns(db)).toEqual({
      sessions: 1,
      states: 1,
      challenges: 2,
    });
    expect(await count("sessions")).toBe(0);
    expect(await count("oauthStates")).toBe(0);
    expect(await count("loginChallenges")).toBe(0);
    expect(await count("webauthnChallenges")).toBe(0);

    // The accounts list still says when the person last signed in.
    const listed = await listUsers(db, { search: email });
    expect(listed.users[0]?.lastSeen).toBe(account.lastSignInAt?.toISOString());
  });

  it("leaves what is still running", async () => {
    const page = browser();
    await page.call().auth.login({ email, password: PASSWORD });
    await db
      .insertInto("oauthStates")
      .values({
        kind: "oidc",
        stateHash: randomBytes(32).toString("hex"),
        verifierCiphertext: randomBytes(16),
        verifierNonce: randomBytes(12),
        expiresAt: future,
      })
      .execute();
    const sessions = await count("sessions");
    expect(sessions).toBeGreaterThanOrEqual(1);

    expect(await purgeExpiredSignIns(db)).toEqual({
      sessions: 0,
      states: 0,
      challenges: 0,
    });
    expect(await count("sessions")).toBe(sessions);
    expect(await count("oauthStates")).toBe(1);
  });
});
