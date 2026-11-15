/**
 * The list of sign-in addresses (ADR 0055), through Administration and
 * the sign-in itself: a list that leaves out the address it is saved from
 * is refused, a saved one refuses a sign-in from elsewhere, and an empty
 * one lets every address in again.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { readSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
} from "../trpc/caller.test-helpers.js";
import { keyRing } from "./key-ring.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const OFFICE = "198.51.100.7";
const ELSEWHERE = "203.0.113.9";

describe("the list of sign-in addresses", () => {
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
  const fromOffice = browserFactory({ db: () => db, env, hub, ip: OFFICE });
  const fromElsewhere = browserFactory({
    db: () => db,
    env,
    hub,
    ip: ELSEWHERE,
  });
  const admin = fromOffice();
  const email = `admin-${suffix}@example.org`;

  beforeAll(async () => {
    const created = await createTestDatabase("signin_addresses");
    db = created.db;
    close = created.close;
    await admin.signUpFirst({
      email,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    await admin.call().admin.stepUp({ password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("refuses a list that leaves out the address it is saved from", async () => {
    const refused = admin
      .call()
      .admin.updateSettings({ signInAllowlist: ["192.0.2.0/24"] });
    await expect(refused).rejects.toMatchObject({
      cause: { code: "sign_in_address_left_out", detail: OFFICE },
    });
    expect((await readSettings(db)).signInAllowlist).toEqual([]);
    // Nothing else of the same save is written either.
    expect(
      await errorCode(
        admin.call().admin.updateSettings({
          signInAllowlist: ["192.0.2.0/24"],
          trashDays: 14,
        }),
      ),
    ).toBe("sign_in_address_left_out");
    expect((await readSettings(db)).trashDays).toBe(30);
  });

  it("saves a list that holds it, and then refuses a sign-in from elsewhere", async () => {
    const saved = await admin.call().admin.updateSettings({
      signInAllowlist: ["198.51.100.0/24", "2001:db8::/32"],
    });
    expect(saved.signInAllowlist).toEqual(["198.51.100.0/24", "2001:db8::/32"]);

    const stranger = fromElsewhere();
    expect(
      await errorCode(
        stranger.call().auth.login({ email, password: PASSWORD }),
      ),
    ).toBe("sign_in_address_denied");
    // The same account, from the office: the password is taken.
    const colleague = fromOffice();
    await expect(
      colleague.call().auth.login({ email, password: PASSWORD }),
    ).resolves.toBeDefined();
  });

  it("lets every address in again once the list is emptied", async () => {
    await admin.call().admin.updateSettings({ signInAllowlist: [] });
    const stranger = fromElsewhere();
    await expect(
      stranger.call().auth.login({ email, password: PASSWORD }),
    ).resolves.toBeDefined();
  });
});
