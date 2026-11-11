import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import { writeSettings } from "../settings.js";
import { registerEnterpriseAuth } from "./enterprise.js";
import { saveTotpSecret } from "./totp.js";
import { generateTotpSecret } from "./totp-code.js";

const suffix = randomBytes(6).toString("hex");
const ISSUER = `http://idp-${suffix}.test`;
const CLIENT_ID = "anygriddb";
const REDIRECT = "http://localhost:4000/auth/oidc/callback";
const WEB = "http://localhost:3000";

type Claims = Record<string, unknown>;

/**
 * A minimal identity provider behind openid-client's fetch hook: discovery,
 * keys, and a token endpoint that signs the claims the test asks for.
 */
async function fakeProvider() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const state = {
    claims: {} as Claims,
    nonce: "",
    codes: [] as string[],
  };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  const fetch = async (
    url: string,
    options: RequestInit,
  ): Promise<Response> => {
    const target = new URL(url);
    if (target.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (target.pathname === "/jwks") return json({ keys: [jwk] });
    if (target.pathname === "/token" && options.method === "POST") {
      const body = new URLSearchParams(options.body as URLSearchParams);
      state.codes.push(body.get("code") ?? "");
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        nonce: state.nonce,
        ...state.claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        // The provider's own name for the person: one per address unless
        // a test says otherwise.
        .setSubject(
          typeof state.claims.sub === "string"
            ? state.claims.sub
            : `sub-${String(state.claims.email)}`,
        )
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
      return json({
        access_token: "at",
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken,
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, state };
}

describe("OIDC sign-in through openid-client", () => {
  let database: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let provider: Awaited<ReturnType<typeof fakeProvider>>;
  const key = randomBytes(32);

  beforeAll(async () => {
    const created = await createTestDatabase("oidc");
    database = created.db;
    close = created.close;
    provider = await fakeProvider();
    const env = {
      AUTH_ENCRYPTION_KEY: key,
      PUBLIC_URL: WEB,
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: "secret",
      OIDC_REDIRECT_URL: REDIRECT,
    } as unknown as Env;
    app = Fastify();
    await app.register(cookie);
    registerEnterpriseAuth(app, {
      env,
      db: database,
      oidcTesting: { fetch: provider.fetch },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  /** Starts a sign-in and returns the state and nonce the app sent. */
  async function start() {
    const response = await app.inject({
      method: "GET",
      url: "/auth/oidc/start",
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers.location));
    expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT);
    return {
      state: location.searchParams.get("state") ?? "",
      nonce: location.searchParams.get("nonce") ?? "",
    };
  }

  async function callback(state: string) {
    return app.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=c-${randomBytes(4).toString("hex")}&state=${encodeURIComponent(state)}`,
    });
  }

  const session = (response: { headers: Record<string, unknown> }): string => {
    const raw = response.headers["set-cookie"];
    if (Array.isArray(raw)) return raw.join(";");
    return typeof raw === "string" ? raw : "";
  };

  it("signs in a verified address and creates the account", async () => {
    const { state, nonce } = await start();
    provider.state.nonce = nonce;
    provider.state.claims = {
      email: `ada-${suffix}@example.com`,
      email_verified: true,
      name: "Ada",
    };
    const response = await callback(state);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/");
    expect(session(response)).toMatch(/=/);
    const user = await database
      .selectFrom("users")
      .select("displayName as name")
      .where("email", "=", `ada-${suffix}@example.com`)
      .executeTakeFirst();
    expect(user?.name).toBe("Ada");
  });

  it("does not attach an unverified address to an account that exists", async () => {
    const email = `ada-${suffix}@example.com`;
    const { state, nonce } = await start();
    provider.state.nonce = nonce;
    provider.state.claims = { email, name: "Ada", sub: `other-${suffix}` };
    const response = await callback(state);
    expect(response.headers.location).toBe("/");
    expect(session(response)).toBe("");
  });

  it("creates an account when the address is new and not marked verified", async () => {
    const email = `new-${suffix}@example.com`;
    const { state, nonce } = await start();
    provider.state.nonce = nonce;
    provider.state.claims = { email, name: "New" };
    const response = await callback(state);
    expect(response.statusCode).toBe(302);
    expect(session(response)).toMatch(/=/);
    const user = await database
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirst();
    expect(user?.id).toBeTruthy();
  });

  it("refuses an address the provider did not verify", async () => {
    const { state, nonce } = await start();
    provider.state.nonce = nonce;
    provider.state.claims = {
      email: `ada-${suffix}@example.com`,
      email_verified: false,
    };
    const response = await callback(state);
    expect(response.headers.location).toBe("/");
    expect(session(response)).toBe("");
  });

  it("refuses a token minted for another sign-in", async () => {
    const { state } = await start();
    provider.state.nonce = "someone-else";
    provider.state.claims = {
      email: `ada-${suffix}@example.com`,
      email_verified: true,
    };
    expect(session(await callback(state))).toBe("");
  });

  it("uses a state once", async () => {
    const { state, nonce } = await start();
    provider.state.nonce = nonce;
    provider.state.claims = {
      email: `ada-${suffix}@example.com`,
      email_verified: true,
    };
    expect(session(await callback(state))).toMatch(/=/);
    expect(session(await callback(state))).toBe("");
  });

  describe("an account bound to the provider's subject", () => {
    const email = `bo-${suffix}@example.com`;
    const userIdOf = async (address: string) =>
      (
        await database
          .selectFrom("users")
          .select("id")
          .where("email", "=", address)
          .executeTakeFirst()
      )?.id;

    async function signInAs(claims: Claims) {
      const { state, nonce } = await start();
      provider.state.nonce = nonce;
      provider.state.claims = { email_verified: true, ...claims };
      return callback(state);
    }

    it("binds the first sign-in, then finds the account by its subject", async () => {
      expect(
        session(await signInAs({ sub: `bo-${suffix}`, email, name: "Bo" })),
      ).toMatch(/=/);
      const id = await userIdOf(email);
      const binding = await database
        .selectFrom("ssoIdentities")
        .select(["provider", "issuer", "userId"])
        .where("subject", "=", `bo-${suffix}`)
        .executeTakeFirst();
      expect(binding).toEqual({ provider: "oidc", issuer: ISSUER, userId: id });
      // The address changed at the provider: the same account signs in,
      // and no other account is made.
      const moved = `bo-new-${suffix}@example.com`;
      expect(
        session(await signInAs({ sub: `bo-${suffix}`, email: moved })),
      ).toMatch(/=/);
      expect(await userIdOf(moved)).toBeUndefined();
    });

    it("refuses another subject that brings a bound account's address", async () => {
      const response = await signInAs({ sub: `intruder-${suffix}`, email });
      expect(session(response)).toBe("");
      const bindings = await database
        .selectFrom("ssoIdentities")
        .select("subject")
        .where("userId", "=", (await userIdOf(email)) ?? "")
        .execute();
      expect(bindings).toEqual([{ subject: `bo-${suffix}` }]);
    });
  });

  describe("with a second factor of AnyGridDB's own (ADR 0043)", () => {
    const email = `mfa-${suffix}@example.com`;

    async function signIn() {
      const { state, nonce } = await start();
      provider.state.nonce = nonce;
      provider.state.claims = { email, email_verified: true, name: "Mo" };
      return callback(state);
    }

    beforeAll(async () => {
      await signIn();
      const user = await database
        .selectFrom("users")
        .select("id")
        .where("email", "=", email)
        .executeTakeFirstOrThrow();
      await saveTotpSecret(database, user.id, generateTotpSecret(), key, 0);
    });

    it("asks for it after the provider, before any session", async () => {
      const response = await signIn();
      expect(response.headers.location).toBe("/login?mfa=1");
      expect(session(response)).toMatch(/__Host-ag_mfa=[A-Za-z0-9_-]{43}/);
      expect(session(response)).not.toMatch(/__Host-ag_session=/);
    });

    it("trusts the provider's when the instance says so", async () => {
      const admin = await database
        .selectFrom("users")
        .select("id")
        .where("email", "=", `ada-${suffix}@example.com`)
        .executeTakeFirstOrThrow();
      await writeSettings(database, admin.id, { ssoMfa: "provider" });
      try {
        const response = await signIn();
        expect(response.headers.location).toBe("/");
        expect(session(response)).toMatch(/__Host-ag_session=/);
      } finally {
        await writeSettings(database, admin.id, { ssoMfa: "local" });
      }
    });
  });
});
