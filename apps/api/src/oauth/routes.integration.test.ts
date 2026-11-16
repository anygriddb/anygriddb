/**
 * The addresses an application talks to (ADR 0094, ADR 0098), over HTTP
 * and against a real database.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findApiToken } from "../auth/tokens.js";
import { insertBase } from "../data/schema-ops.js";
import { acceptFormBodies } from "../http.js";
import { createTestDatabase } from "../test-database.js";
import { registerOauthClient } from "./clients.js";
import { issueAuthorizationCode } from "./flow.js";
import { codeChallengeS256 } from "./pkce.js";
import { registerOauth } from "./routes.js";

const suffix = randomBytes(6).toString("hex");
const redirectUri = "http://127.0.0.1:9999/callback";
const verifier = `v_${"d".repeat(43)}`;

describe("oauth over HTTP", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let person = "";
  let baseId = "";
  let clientId = "";
  let clientSecret = "";

  beforeAll(async () => {
    const created = await createTestDatabase("oauth_routes");
    db = created.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        {
          email: `oauth-http-admin-${suffix}@example.org`,
          displayName: "Admin",
          isAdmin: true,
        },
        {
          email: `oauth-http-person-${suffix}@example.org`,
          displayName: "Person",
        },
      ])
      .returning("id")
      .execute();
    person = people[1]?.id ?? "";
    baseId = (await insertBase(db, person, { name: "Granted" })).id;
    const client = await registerOauthClient(db, people[0]?.id ?? "", {
      name: "Notebook bridge",
      redirectUris: [redirectUri],
    });
    clientId = client.clientId;
    clientSecret = client.clientSecret;
    app = Fastify();
    acceptFormBodies(app);
    registerOauth(app, { db, publicUrl: "https://grid.example.org" });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  async function code(): Promise<string> {
    const issued = await issueAuthorizationCode(db, person, {
      clientId,
      redirectUri,
      codeChallenge: codeChallengeS256(verifier),
      baseIds: [baseId],
      readOnly: true,
    });
    return issued.code;
  }

  const basic = (secret = clientSecret) =>
    `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;

  function post(
    url: string,
    fields: Record<string, string>,
    authorization?: string,
  ) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(authorization ? { authorization } : {}),
      },
      payload: new URLSearchParams(fields).toString(),
    });
  }

  it("publishes where the grant's addresses are", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      issuer: "https://grid.example.org",
      token_endpoint: "https://grid.example.org/oauth/token",
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("exchanges a code for a client that proves itself by header, then renews and revokes by body", async () => {
    const exchanged = await post(
      "/oauth/token",
      {
        grant_type: "authorization_code",
        code: await code(),
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      basic(),
    );
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.headers["cache-control"]).toBe("no-store");
    const tokens = exchanged.json<{
      access_token: string;
      refresh_token: string;
    }>();
    expect(
      (await findApiToken(db, `Bearer ${tokens.access_token}`))?.user.id,
    ).toBe(person);

    const renewed = await post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(renewed.statusCode).toBe(200);
    const next = renewed.json<{
      access_token: string;
      refresh_token: string;
    }>();

    const revoked = await post("/oauth/revoke", {
      token: next.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(revoked.statusCode).toBe(200);
    expect(await findApiToken(db, `Bearer ${next.access_token}`)).toBeNull();
    // A token already gone answers the same.
    expect(
      (await post("/oauth/revoke", { token: next.refresh_token }, basic()))
        .statusCode,
    ).toBe(200);
  });

  it("answers invalid_client to a client that does not prove itself, and invalid_grant to a wrong code", async () => {
    const wrongSecret = await post(
      "/oauth/token",
      {
        grant_type: "authorization_code",
        code: await code(),
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      basic("ags_wrong"),
    );
    expect(wrongSecret.statusCode).toBe(401);
    expect(wrongSecret.json()).toEqual({ error: "invalid_client" });
    expect(wrongSecret.headers["www-authenticate"]).toBe('Basic realm="oauth"');

    const bearer = await post(
      "/oauth/token",
      { grant_type: "refresh_token", refresh_token: "agr_x" },
      "Bearer ag_not_a_client",
    );
    expect(bearer.statusCode).toBe(401);

    const wrongCode = await post(
      "/oauth/token",
      {
        grant_type: "authorization_code",
        code: "ago_unknown",
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      basic(),
    );
    expect(wrongCode.statusCode).toBe(400);
    expect(wrongCode.json()).toEqual({ error: "invalid_grant" });

    const revokeRefused = await post(
      "/oauth/revoke",
      { token: "agr_x" },
      basic("ags_wrong"),
    );
    expect(revokeRefused.statusCode).toBe(401);
  });

  it("refuses a secret sent twice, and a grant it does not give", async () => {
    const twice = await post(
      "/oauth/token",
      {
        grant_type: "refresh_token",
        refresh_token: "agr_x",
        client_secret: clientSecret,
      },
      basic(),
    );
    expect(twice.statusCode).toBe(400);
    expect(twice.json()).toMatchObject({ error: "invalid_request" });

    const password = await post(
      "/oauth/token",
      { grant_type: "password", username: "a", password: "b" },
      basic(),
    );
    expect(password.statusCode).toBe(400);
    expect(password.json()).toEqual({ error: "unsupported_grant_type" });
  });
});
