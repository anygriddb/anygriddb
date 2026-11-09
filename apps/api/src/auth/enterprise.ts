import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { SAML } from "@node-saml/node-saml";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as oidc from "openid-client";
import { factorMethods } from "./access.js";
import { recordAuthEvent } from "./auth-events.js";
import { MFA_COOKIE, createLoginChallenge } from "./challenge.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  SESSION_COOKIE,
  createSession,
  hashSessionToken,
  sessionCookieOptions,
} from "./session.js";
import { userForEmail } from "./sso.js";
import type { Env } from "../env.js";
import { readSettings } from "../settings.js";
import { AppError } from "@anygriddb/core";

type Deps = {
  env: Env;
  db: Database;
  /** Tests only: a fake identity provider, reached over plain HTTP. */
  oidcTesting?: { fetch: oidc.CustomFetch };
};

function oidcReady(env: Env): env is Env & {
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  OIDC_REDIRECT_URL: string;
} {
  return Boolean(
    env.OIDC_ISSUER &&
    env.OIDC_CLIENT_ID &&
    env.OIDC_CLIENT_SECRET &&
    env.OIDC_REDIRECT_URL,
  );
}

function samlReady(env: Env): env is Env & {
  SAML_ENTRY_POINT: string;
  SAML_ISSUER: string;
  SAML_CERT: string;
  SAML_CALLBACK_URL: string;
} {
  return Boolean(
    env.SAML_ENTRY_POINT &&
    env.SAML_ISSUER &&
    env.SAML_CERT &&
    env.SAML_CALLBACK_URL,
  );
}

async function saveState(
  db: Database,
  key: Buffer,
  kind: "oidc" | "saml",
  payload: { verifier: string; nonce: string },
): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const sealed = encryptSecret(JSON.stringify(payload), key);
  await db
    .insertInto("oauthStates")
    .values({
      stateHash: hashSessionToken(state),
      kind,
      verifierCiphertext: sealed.ciphertext,
      verifierNonce: sealed.nonce,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    })
    .execute();
  return state;
}

async function takeState(
  db: Database,
  key: Buffer,
  kind: string,
  state: string,
): Promise<{ verifier: string; nonce: string }> {
  // One statement takes the state: it is used once, even under a race.
  const row = await db
    .deleteFrom("oauthStates")
    .where("stateHash", "=", hashSessionToken(state))
    .where("kind", "=", kind)
    .where("expiresAt", ">", new Date())
    .returningAll()
    .executeTakeFirst();
  if (!row) {
    throw new AppError("challenge_expired");
  }
  const parsed = JSON.parse(
    decryptSecret(row.verifierCiphertext, row.verifierNonce, key),
  ) as { verifier?: unknown; nonce?: unknown };
  if (typeof parsed.verifier !== "string" || typeof parsed.nonce !== "string") {
    throw new AppError("challenge_expired");
  }
  return { verifier: parsed.verifier, nonce: parsed.nonce };
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
let discovered:
  { at: number; issuer: string; config: oidc.Configuration } | undefined;

/**
 * The provider's configuration, discovered once an hour. openid-client
 * checks that the metadata names the configured issuer, then validates
 * every response: state, nonce, PKCE, signature, audience, and expiry.
 */
async function oidcConfig(
  deps: Deps,
  env: Env & {
    OIDC_ISSUER: string;
    OIDC_CLIENT_ID: string;
    OIDC_CLIENT_SECRET: string;
  },
): Promise<oidc.Configuration> {
  if (
    discovered &&
    discovered.issuer === env.OIDC_ISSUER &&
    Date.now() - discovered.at < DISCOVERY_TTL_MS
  ) {
    return discovered.config;
  }
  const testing = deps.oidcTesting;
  const config = await oidc.discovery(
    new URL(env.OIDC_ISSUER),
    env.OIDC_CLIENT_ID,
    env.OIDC_CLIENT_SECRET,
    undefined,
    {
      timeout: 5,
      ...(testing
        ? {
            [oidc.customFetch]: testing.fetch,
            // Tests reach a fake provider over HTTP; production never sets
            // `oidcTesting`, so HTTPS stays required there.
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            execute: [oidc.allowInsecureRequests],
          }
        : {}),
    },
  );
  if (testing) config[oidc.customFetch] = testing.fetch;
  discovered = { at: Date.now(), issuer: env.OIDC_ISSUER, config };
  return config;
}

async function signedIn(
  db: Database,
  request: FastifyRequest,
  userId: string,
  method: "oidc" | "saml",
): Promise<void> {
  await recordAuthEvent(db, {
    action: "login_success",
    userId,
    method,
    ip: request.ip,
  });
}

/**
 * After the identity provider vouched for the person: a session, or first
 * AnyGridDB's own second step when the policy asks for it and the account
 * has a factor (ADR 0043). Returns where the browser goes.
 */
async function finishSignIn(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  method: "oidc" | "saml",
): Promise<string> {
  const policy = await readSettings(deps.db);
  if (
    policy.ssoMfa === "local" &&
    (await factorMethods(deps.db, userId)).length > 0
  ) {
    const account = await deps.db
      .selectFrom("users")
      .select(["disabledAt", "isAdmin"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!account || account.disabledAt) throw new AppError("account_disabled");
    if (!account.isAdmin && policy.maintenance) {
      throw new AppError("instance_maintenance");
    }
    const challenge = await createLoginChallenge(deps.db, userId);
    reply.setCookie(
      MFA_COOKIE,
      challenge.token,
      sessionCookieOptions(challenge.expiresAt),
    );
    return "/login?mfa=1";
  }
  const session = await createSession(deps.db, userId);
  reply.setCookie(
    SESSION_COOKIE,
    session.token,
    sessionCookieOptions(session.expiresAt),
  );
  await signedIn(deps.db, request, userId, method);
  return "/";
}

/** The trail keeps why, without the provider's account: it may be anyone. */
async function signInRefused(
  db: Database,
  request: FastifyRequest,
  method: "oidc" | "saml",
  error: unknown,
): Promise<void> {
  const detail =
    error instanceof AppError &&
    (error.code === "account_disabled" || error.code === "instance_maintenance")
      ? error.code
      : "invalid_credentials";
  try {
    await recordAuthEvent(db, {
      action: "login_failure",
      method,
      detail,
      ip: request.ip,
    });
  } catch (cause) {
    request.log.error({ err: cause }, "sign-in trail write failed");
  }
}

export function registerEnterpriseAuth(app: FastifyInstance, deps: Deps): void {
  app.get("/auth/oidc/start", async (_request, reply) => {
    if (!oidcReady(deps.env)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const config = await oidcConfig(deps, deps.env);
    const verifier = oidc.randomPKCECodeVerifier();
    const nonce = oidc.randomNonce();
    const state = await saveState(
      deps.db,
      deps.env.AUTH_ENCRYPTION_KEY,
      "oidc",
      { verifier, nonce },
    );
    const authorize = oidc.buildAuthorizationUrl(config, {
      redirect_uri: deps.env.OIDC_REDIRECT_URL,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    return reply.redirect(authorize.href);
  });

  app.get("/auth/oidc/callback", async (request, reply) => {
    if (!oidcReady(deps.env)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const query = request.query as { code?: unknown; state?: unknown };
    let next = "/";
    try {
      if (typeof query.code !== "string" || typeof query.state !== "string") {
        throw new AppError("challenge_expired");
      }
      const saved = await takeState(
        deps.db,
        deps.env.AUTH_ENCRYPTION_KEY,
        "oidc",
        query.state,
      );
      const config = await oidcConfig(deps, deps.env);
      // The callback as the provider called it: the registered redirect URL
      // with the query it appended (code, state, and maybe iss).
      const current = new URL(deps.env.OIDC_REDIRECT_URL);
      const raw = request.raw.url ?? "";
      current.search = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: saved.verifier,
        expectedNonce: saved.nonce,
        expectedState: query.state,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const email = claims?.email;
      const name = claims?.name;
      // Accounts are matched by email: an address the provider says it did
      // not verify could take over someone else's account.
      if (typeof email !== "string" || claims?.email_verified === false) {
        throw new AppError("invalid_credentials");
      }
      const userId = await userForEmail(
        deps.db,
        email,
        typeof name === "string" ? name : email,
        deps.env.ADMIN_EMAILS,
      );
      next = await finishSignIn(deps, request, reply, userId, "oidc");
    } catch (error) {
      request.log.warn({ err: error }, "authentication failed");
      await signInRefused(deps.db, request, "oidc", error);
    }
    // Signed in or not, the browser goes back to the app.
    return reply.redirect(next);
  });

  app.get("/auth/saml/start", async (_request, reply) => {
    if (!samlReady(deps.env)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const state = await saveState(
      deps.db,
      deps.env.AUTH_ENCRYPTION_KEY,
      "saml",
      {
        verifier: randomBytes(16).toString("base64url"),
        nonce: randomBytes(16).toString("base64url"),
      },
    );
    const saml = new SAML({
      entryPoint: deps.env.SAML_ENTRY_POINT,
      issuer: deps.env.SAML_ISSUER,
      idpCert: deps.env.SAML_CERT,
      callbackUrl: deps.env.SAML_CALLBACK_URL,
      wantAssertionsSigned: true,
      audience: deps.env.SAML_ISSUER,
    });
    const url = await saml.getAuthorizeUrlAsync(state, undefined, {});
    return reply.redirect(url);
  });

  app.post("/auth/saml/acs", async (request, reply) => {
    if (!samlReady(deps.env)) {
      return reply.code(404).send({ error: "Not found" });
    }
    let next = "/";
    try {
      const body = request.body as {
        SAMLResponse?: unknown;
        RelayState?: unknown;
      };
      if (
        typeof body.SAMLResponse !== "string" ||
        typeof body.RelayState !== "string"
      ) {
        throw new AppError("challenge_expired");
      }
      await takeState(
        deps.db,
        deps.env.AUTH_ENCRYPTION_KEY,
        "saml",
        body.RelayState,
      );
      const saml = new SAML({
        entryPoint: deps.env.SAML_ENTRY_POINT,
        issuer: deps.env.SAML_ISSUER,
        idpCert: deps.env.SAML_CERT,
        callbackUrl: deps.env.SAML_CALLBACK_URL,
        wantAssertionsSigned: true,
        audience: deps.env.SAML_ISSUER,
      });
      const result = await saml.validatePostResponseAsync({
        SAMLResponse: body.SAMLResponse,
      });
      const email =
        result.profile?.email ?? result.profile?.mail ?? result.profile?.nameID;
      if (!email || !email.includes("@")) {
        throw new AppError("invalid_credentials");
      }
      const userId = await userForEmail(
        deps.db,
        email,
        email,
        deps.env.ADMIN_EMAILS,
      );
      next = await finishSignIn(deps, request, reply, userId, "saml");
    } catch (error) {
      request.log.warn({ err: error }, "authentication failed");
      await signInRefused(deps.db, request, "saml", error);
    }
    // Signed in or not, the browser goes back to the app.
    return reply.redirect(next);
  });
}
