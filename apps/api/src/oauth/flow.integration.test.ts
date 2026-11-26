/**
 * OAuth authorization code + PKCE (ADR 0094), against a real database.
 */
import { giveInstanceRole } from "../auth/instance-roles.test-helpers.js";
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findApiToken } from "../auth/tokens.js";
import { eraseAccount } from "../data/erasure.js";
import { insertBase } from "../data/schema-ops.js";
import { revokeAllTokens, revokeUserTokens } from "../admin-control.js";
import { createTestDatabase } from "../test-database.js";
import { errorCode as refusal } from "../trpc/caller.test-helpers.js";
import {
  listOauthClients,
  registerOauthClient,
  revokeOauthClient,
} from "./clients.js";
import {
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  purgeOauthGrants,
  refreshAccessToken,
  revokeGrantToken,
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
        },
        {
          email: `oauth-person-${suffix}@example.org`,
          displayName: "Person",
        },
      ])
      .returning("id")
      .execute();
    await giveInstanceRole(db, people[0]?.id ?? "");
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

    await revokeGrantToken(db, {
      clientId,
      clientSecret,
      token: second.refresh_token,
    });
    expect(await findApiToken(db, `Bearer ${second.access_token}`)).toBeNull();
  });

  const verifier = `v_${"b".repeat(43)}`;

  /** A code the person consented to, for the client registered above. */
  function consent(bases: string[] = [baseId]) {
    return issueAuthorizationCode(db, person, {
      clientId,
      redirectUri,
      codeChallenge: codeChallengeS256(verifier),
      baseIds: bases,
    });
  }

  function exchange(
    code: string,
    change: Partial<Parameters<typeof exchangeAuthorizationCode>[1]> = {},
  ) {
    return exchangeAuthorizationCode(db, {
      clientId,
      clientSecret,
      code,
      redirectUri,
      codeVerifier: verifier,
      ...change,
    });
  }

  it("ends a grant from its access token too, for this client alone", async () => {
    const grant = await exchange((await consent()).code);
    const other = await registerOauthClient(db, admin, {
      name: "Another bridge",
      redirectUris: [redirectUri],
    });
    await revokeGrantToken(db, {
      clientId: other.clientId,
      clientSecret: other.clientSecret,
      token: grant.access_token,
    });
    expect(
      await findApiToken(db, `Bearer ${grant.access_token}`),
    ).not.toBeNull();

    await revokeGrantToken(db, {
      clientId,
      clientSecret,
      token: grant.access_token,
    });
    expect(await findApiToken(db, `Bearer ${grant.access_token}`)).toBeNull();
    expect(
      await refusal(
        refreshAccessToken(db, {
          clientId,
          clientSecret,
          refreshToken: grant.refresh_token,
        }),
      ),
    ).toBe("invalid_input");
  });

  it("takes back a code not yet exchanged with an account's tokens", async () => {
    const one = await consent();
    await revokeUserTokens(db, admin, person);
    expect(await refusal(exchange(one.code))).toBe("invalid_input");
    const two = await consent();
    await revokeAllTokens(db, admin);
    expect(await refusal(exchange(two.code))).toBe("invalid_input");
  });

  it("refuses a consent for an address the client did not register, or a base the person does not read", async () => {
    expect(
      await refusal(
        issueAuthorizationCode(db, person, {
          clientId,
          redirectUri: "https://elsewhere.example/callback",
          codeChallenge: codeChallengeS256(verifier),
          baseIds: [baseId],
        }),
      ),
    ).toBe("invalid_input");
    const hidden = await insertBase(db, admin, { name: "Not theirs" });
    expect(await refusal(consent([hidden.id]))).toBe("access_denied");
  });

  it("refuses an exchange with a wrong secret, verifier, address or client, and leaves the code to its owner", async () => {
    const { code } = await consent();
    expect(await refusal(exchange(code, { clientSecret: "ags_wrong" }))).toBe(
      "invalid_input",
    );
    expect(
      await refusal(exchange(code, { codeVerifier: `v_${"c".repeat(43)}` })),
    ).toBe("invalid_input");
    expect(
      await refusal(
        exchange(code, { redirectUri: "http://127.0.0.1:9999/other" }),
      ),
    ).toBe("invalid_input");
    expect(await refusal(exchange(code, { clientId: "agc_unknown" }))).toBe(
      "invalid_input",
    );
    expect((await exchange(code)).token_type).toBe("Bearer");
  });

  it("refuses a code past its time", async () => {
    const { code } = await consent();
    await db
      .updateTable("oauthAuthorizationCodes")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("usedAt", "is", null)
      .execute();
    expect(await refusal(exchange(code))).toBe("invalid_input");
  });

  it("refuses to register an address a code must not go back to", async () => {
    for (const uri of [
      "https://app.example.org/back#part",
      "https://app.example.org/back#",
      "https://someone:secret@app.example.org/back",
      "http://app.example.org/back",
      "javascript:alert(1)",
    ]) {
      await expect(
        registerOauthClient(db, admin, {
          name: "Refused",
          redirectUris: [uri],
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("gives one pair of tokens when a code is exchanged twice at once", async () => {
    const { code } = await consent();
    const answers = await Promise.allSettled([exchange(code), exchange(code)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  it("gives one pair of tokens when a refresh token is used twice at once, and none for the one it replaced", async () => {
    const first = await exchange((await consent()).code);
    const renew = () =>
      refreshAccessToken(db, {
        clientId,
        clientSecret,
        refreshToken: first.refresh_token,
      });
    const answers = await Promise.allSettled([renew(), renew()]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await findApiToken(db, `Bearer ${first.access_token}`)).toBeNull();
    expect(await refusal(renew())).toBe("invalid_input");
    const kept = answers.find((answer) => answer.status === "fulfilled");
    expect(
      (await findApiToken(db, `Bearer ${kept?.value.access_token ?? ""}`))?.user
        .id,
    ).toBe(person);
  });

  it("refuses a refresh token past its time, and deletes what ran out", async () => {
    const tokens = await exchange((await consent()).code);
    const { code: unused } = await consent();
    await db
      .updateTable("oauthRefreshTokens")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .execute();
    await db
      .updateTable("oauthAuthorizationCodes")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("usedAt", "is", null)
      .execute();
    expect(
      await refusal(
        refreshAccessToken(db, {
          clientId,
          clientSecret,
          refreshToken: tokens.refresh_token,
        }),
      ),
    ).toBe("invalid_input");
    await purgeOauthGrants(db);
    const left = await db
      .selectNoFrom((eb) => [
        eb
          .selectFrom("oauthAuthorizationCodes")
          .select((b) => b.fn.countAll<string>().as("n"))
          .as("codes"),
        eb
          .selectFrom("oauthRefreshTokens")
          .select((b) => b.fn.countAll<string>().as("n"))
          .as("refreshTokens"),
      ])
      .executeTakeFirstOrThrow();
    expect(left).toEqual({ codes: "0", refreshTokens: "0" });
    expect(await refusal(exchange(unused))).toBe("invalid_input");
  });

  it("stops a revoked client: its tokens go, and it takes no new consent", async () => {
    const other = await registerOauthClient(db, admin, {
      name: "Short-lived",
      redirectUris: [redirectUri],
    });
    const { code } = await issueAuthorizationCode(db, person, {
      clientId: other.clientId,
      redirectUri,
      codeChallenge: codeChallengeS256(verifier),
      baseIds: [baseId],
    });
    const tokens = await exchangeAuthorizationCode(db, {
      clientId: other.clientId,
      clientSecret: other.clientSecret,
      code,
      redirectUri,
      codeVerifier: verifier,
    });
    await revokeOauthClient(db, admin, other.id);
    expect(await findApiToken(db, `Bearer ${tokens.access_token}`)).toBeNull();
    expect(
      await refusal(
        issueAuthorizationCode(db, person, {
          clientId: other.clientId,
          redirectUri,
          codeChallenge: codeChallengeS256(verifier),
          baseIds: [baseId],
        }),
      ),
    ).toBe("invalid_input");
  });

  it("keeps a client when the administrator who registered it is deleted", async () => {
    const registrar = await db
      .insertInto("users")
      .values({
        email: `oauth-registrar-${suffix}@example.org`,
        displayName: "Registrar",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await giveInstanceRole(db, registrar.id);
    const theirs = await registerOauthClient(db, registrar.id, {
      name: "Outlives its author",
      redirectUris: [redirectUri],
    });
    await eraseAccount(db, registrar.id);
    expect((await listOauthClients(db)).map((client) => client.id)).toContain(
      theirs.id,
    );
  });
});
