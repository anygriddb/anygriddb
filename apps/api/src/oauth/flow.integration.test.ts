/**
 * OAuth authorization code + PKCE (ADR 0094), against a real database.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findApiToken } from "../auth/tokens.js";
import { insertBase } from "../data/schema-ops.js";
import { createTestDatabase } from "../test-database.js";
import { registerOauthClient } from "./clients.js";
import {
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  refreshAccessToken,
  revokeRefreshToken,
} from "./flow.js";
import { codeChallengeS256 } from "./pkce.js";

const suffix = randomBytes(6).toString("hex");

describe("oauth authorization code", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin = "";
  let person = "";
  let baseId = "";
  let clientId = "";
  let clientSecret = "";
  const redirectUri = "http://127.0.0.1:9999/callback";

  beforeAll(async () => {
    const created = await createTestDatabase("oauth_flow");
    db = created.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        {
          email: `oauth-admin-${suffix}@example.org`,
          displayName: "Admin",
          isAdmin: true,
        },
        {
          email: `oauth-person-${suffix}@example.org`,
          displayName: "Person",
        },
      ])
      .returning("id")
      .execute();
    admin = people[0]?.id ?? "";
    person = people[1]?.id ?? "";
    baseId = (await insertBase(db, person, { name: "Granted" })).id;
    const client = await registerOauthClient(db, admin, {
      name: "Notebook bridge",
      redirectUris: [redirectUri],
    });
    clientId = client.clientId;
    clientSecret = client.clientSecret;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("exchanges a consent for a bearer that finds the person, then refreshes and revokes", async () => {
    const verifier = `v_${"a".repeat(43)}`;
    const { code } = await issueAuthorizationCode(db, person, {
      clientId,
      redirectUri,
      codeChallenge: codeChallengeS256(verifier),
      baseIds: [baseId],
      readOnly: true,
    });

    const first = await exchangeAuthorizationCode(db, {
      clientId,
      clientSecret,
      code,
      redirectUri,
      codeVerifier: verifier,
    });
    expect(first.token_type).toBe("Bearer");
    expect(first.access_token.startsWith("ag_")).toBe(true);

    const found = await findApiToken(db, `Bearer ${first.access_token}`);
    expect(found?.user.id).toBe(person);
    expect(found?.scope.baseIds).toEqual([baseId]);
    expect(found?.scope.readOnly).toBe(true);

    await expect(
      exchangeAuthorizationCode(db, {
        clientId,
        clientSecret,
        code,
        redirectUri,
        codeVerifier: verifier,
      }),
    ).rejects.toThrow();

    const second = await refreshAccessToken(db, {
      clientId,
      clientSecret,
      refreshToken: first.refresh_token,
    });
    expect(await findApiToken(db, `Bearer ${first.access_token}`)).toBeNull();
    expect(
      (await findApiToken(db, `Bearer ${second.access_token}`))?.user.id,
    ).toBe(person);

    await revokeRefreshToken(db, {
      clientId,
      clientSecret,
      refreshToken: second.refresh_token,
    });
    expect(await findApiToken(db, `Bearer ${second.access_token}`)).toBeNull();
  });
});
