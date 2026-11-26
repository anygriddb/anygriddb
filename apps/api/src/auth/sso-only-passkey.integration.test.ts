/**
 * A passkey does not finish a password sign-in begun before "single sign-on
 * only". The ceremony itself is someone else's test: here it succeeds.
 */
import { giveInstanceRole } from "./instance-roles.test-helpers.js";
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, errorCode } from "../trpc/caller.test-helpers.js";
import { createLoginChallenge, MFA_COOKIE } from "./challenge.js";
import { keyRing } from "./key-ring.js";
import { SESSION_COOKIE } from "./session.js";

vi.mock("./webauthn.js", async (original) => ({
  ...(await original<typeof import("./webauthn.js")>()),
  finishAuthentication: vi.fn(() => Promise.resolve()),
}));

const suffix = randomBytes(5).toString("hex");
const RESPONSE = {
  id: "credential",
  rawId: "credential",
  type: "public-key" as const,
  clientExtensionResults: {},
  response: {
    clientDataJSON: "e30",
    authenticatorData: "e30",
    signature: "e30",
  },
};

describe("a passkey under single sign-on only", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let adminId = "";
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

  const account = async (label: string, isAdmin = false) => {
    const { id } = await db
      .insertInto("users")
      .values({
        email: `${label}-${suffix}@example.org`,
        displayName: label,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (isAdmin) await giveInstanceRole(db, id);
    return id;
  };

  const challenged = async (
    userId: string,
    signOn?: { provider: "oidc" | "saml" },
  ) => {
    const page = browser();
    page.jar[MFA_COOKIE] = (
      await createLoginChallenge(db, userId, signOn)
    ).token;
    return page;
  };

  beforeAll(async () => {
    const created = await createTestDatabase("sso_only_passkey");
    db = created.db;
    close = created.close;
    adminId = await account("admin", true);
    await writeSettings(db, adminId, { ssoOnly: true });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("does not finish a sign-in begun with a password", async () => {
    const page = await challenged(await account("late"));
    expect(
      await errorCode(page.call().auth.webauthn.authenticateFinish(RESPONSE)),
    ).toBe("password_sign_in_disabled");
    expect(page.jar[SESSION_COOKIE]).toBeFalsy();
  });

  it("finishes one that came through the provider", async () => {
    const page = await challenged(await account("sso"), { provider: "saml" });
    await page.call().auth.webauthn.authenticateFinish(RESPONSE);
    expect(page.jar[SESSION_COOKIE]).toBeTruthy();
  });

  it("finishes an administrator's", async () => {
    const page = await challenged(await account("second-admin", true));
    await page.call().auth.webauthn.authenticateFinish(RESPONSE);
    expect(page.jar[SESSION_COOKIE]).toBeTruthy();
  });
});
