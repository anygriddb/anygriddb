/**
 * The first account of an instance administers it, and is made with a
 * token only its operator can ask for (ADR 0080): refused without it,
 * with a wrong one, with one used or too old; and asked of no account
 * after the first.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasAccounts } from "../admin.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, errorCode } from "../trpc/caller.test-helpers.js";
import {
  INSTALL_TOKEN_TTL_MS,
  mintInstallToken,
  useInstallToken,
} from "./installation-token.js";
import { keyRing } from "./key-ring.js";
import { userForIdentity } from "./sso.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("the token the first account is made with", () => {
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
  const first = {
    email: `first-${suffix}@example.org`,
    displayName: "Fay First",
    password: PASSWORD,
  };

  beforeAll(async () => {
    const created = await createTestDatabase("install_token");
    db = created.db;
    close = created.close;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("is asked of the first sign-up, whoever reaches the page", async () => {
    const stranger = browser();
    expect((await stranger.call().auth.instance()).firstAccount).toBe(true);
    expect(await errorCode(stranger.call().auth.signup(first))).toBe(
      "install_token_required",
    );
    expect(
      await errorCode(
        stranger.call().auth.signup({ ...first, installToken: "a guess" }),
      ),
    ).toBe("install_token_invalid");
    // A provider's sign-on has no place to give it: no account is made.
    expect(
      await errorCode(
        userForIdentity(
          db,
          {
            provider: "oidc",
            issuer: "https://idp.example.org",
            subject: "first",
          },
          first.email,
          "Fay First",
        ),
      ),
    ).toBe("install_token_required");
    expect(await hasAccounts(db)).toBe(false);
  });

  it("stops working once replaced, used, or an hour old", async () => {
    const replaced = await mintInstallToken(db);
    const current = await mintInstallToken(db);
    expect(replaced?.token).not.toBe(current?.token);
    expect(await errorCode(useInstallToken(db, replaced?.token))).toBe(
      "install_token_invalid",
    );
    const late = new Date(Date.now() + INSTALL_TOKEN_TTL_MS + 1_000);
    expect(await errorCode(useInstallToken(db, current?.token, late))).toBe(
      "install_token_invalid",
    );
    await useInstallToken(db, current?.token);
    expect(await errorCode(useInstallToken(db, current?.token))).toBe(
      "install_token_invalid",
    );
  });

  it("makes the instance's administrator, and is asked of nobody after", async () => {
    const operator = browser();
    const made = await mintInstallToken(db);
    expect(made?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A password the policy refuses costs no token.
    expect(
      await errorCode(
        operator.call().auth.signup({
          ...first,
          password: "short",
          installToken: made?.token,
        }),
      ),
    ).not.toBe("ok");
    expect(
      await operator
        .call()
        .auth.signup({ ...first, installToken: made?.token }),
    ).toEqual({ status: "session" });
    expect(
      await db
        .selectFrom("users")
        .select(["email", "isAdmin"])
        .where("email", "=", first.email)
        .execute(),
    ).toEqual([{ email: first.email, isAdmin: true }]);
    // The trail keeps that a token was asked for and used, never the token.
    const actions = (
      await db.selectFrom("authEvents").select(["action", "detail"]).execute()
    ).map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining(["install_token_issued", "install_token_used"]),
    );
    expect((await operator.call().auth.instance()).firstAccount).toBe(false);
    // The command has nothing to give an instance that has an account.
    expect(await mintInstallToken(db)).toBeNull();
  });
});
