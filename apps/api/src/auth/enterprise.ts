import { declaredRoute } from "../access/routes.js";
import type { KeyRing } from "./key-ring.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, customFetch, type JWTVerifyGetKey } from "jose";
import * as oidc from "openid-client";
import { factorMethods } from "./access.js";
import { recordAuthEvent } from "./auth-events.js";
import { MFA_COOKIE, createLoginChallenge } from "./challenge.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  endProviderSessions,
  hashProviderSession,
  spendLogoutToken,
  verifyLogoutToken,
} from "./oidc-logout.js";
import {
  oidcAnnouncesOneFactor,
  samlAnnouncesOneFactor,
  samlRecipientHolds,
  samlSessionEnd,
} from "./saml-assertion.js";
import {
  SESSION_COOKIE,
  SSO_AGAIN_COOKIE,
  createSession,
  hashSessionToken,
  sessionCookieOptions,
  ssoAgainOptions,
  type SignOn,
} from "./session.js";
import { samlRequestCache } from "./saml-cache.js";
import { sendSecurityNotice } from "./security-mail.js";
import { stableNameId, userForIdentity } from "./sso.js";
import { isUniqueViolation } from "../data/schema-ops.js";
import type { Env } from "../env.js";
import { resolveOidc, type OidcConfig } from "../integrations/oidc.js";
import {
  resolveSaml,
  samlCertificates,
  type SamlConfig,
} from "../integrations/saml.js";
import { assertSignInAddressAllowed } from "./sign-in-allowlist.js";
import { readSettings } from "../settings.js";
import { AppError, signOnRefusal } from "@anygriddb/core";

type Deps = {
  env: Env;
  db: Database;
  /** Ends the live connections of a session that ended. */
  closeSession?: (tokenHash: string) => void;
  /** Tests only: a fake identity provider, reached over plain HTTP. */
  oidcTesting?: { fetch: oidc.CustomFetch };
};

/** How long a sign-in started at the provider may take to come back. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The browser that starts a single sign-on gets a random value of its own,
 * and the state of the sign-in keeps its hash: the provider's answer is
 * taken only from a browser that shows it. Without it, an answer the
 * provider gave one browser would sign another in, to the account of the
 * first. One cookie per protocol: SAML returns by a cross-site POST, which
 * carries only a cookie marked `SameSite=None`; OIDC by a top-level GET.
 */
export const SSO_BROWSER_COOKIES = {
  oidc: "__Host-ag_sso_oidc",
  saml: "__Host-ag_sso_saml",
} as const;
const BROWSER_VALUE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The browser's value, kept if it has one: two sign-ins started in two
 * tabs both come back.
 */
function browserValue(
  request: FastifyRequest,
  reply: FastifyReply,
  kind: "oidc" | "saml",
): string {
  const name = SSO_BROWSER_COOKIES[kind];
  const held = request.cookies[name];
  const value =
    held && BROWSER_VALUE.test(held)
      ? held
      : randomBytes(32).toString("base64url");
  reply.setCookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: kind === "saml" ? "none" : "lax",
    path: "/",
    maxAge: STATE_TTL_MS / 1000,
  });
  return value;
}

function sameBrowser(expected: unknown, shown: string | undefined): boolean {
  if (typeof expected !== "string" || !shown || !BROWSER_VALUE.test(shown)) {
    return false;
  }
  const given = Buffer.from(hashSessionToken(shown));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function saveState(
  db: Database,
  key: KeyRing,
  kind: "oidc" | "saml",
  payload: { verifier: string; nonce: string; browser: string },
): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const sealed = encryptSecret(
    JSON.stringify({ ...payload, browser: hashSessionToken(payload.browser) }),
    key,
    "sso-state",
  );
  await db
    .insertInto("oauthStates")
    .values({
      stateHash: hashSessionToken(state),
      kind,
      verifierCiphertext: sealed.ciphertext,
      verifierNonce: sealed.nonce,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    })
    .execute();
  return state;
}

/**
 * Takes the state of a sign-in, once, for the browser that started it. A
 * state from another browser is spent all the same: it cannot be tried
 * again from the right one by whoever holds it.
 */
async function takeState(
  db: Database,
  key: KeyRing,
  kind: "oidc" | "saml",
  state: string,
  request: FastifyRequest,
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
    decryptSecret(row.verifierCiphertext, row.verifierNonce, key, "sso-state"),
  ) as { verifier?: unknown; nonce?: unknown; browser?: unknown };
  if (
    typeof parsed.verifier !== "string" ||
    typeof parsed.nonce !== "string" ||
    !sameBrowser(parsed.browser, request.cookies[SSO_BROWSER_COOKIES[kind]])
  ) {
    throw new AppError("challenge_expired");
  }
  return { verifier: parsed.verifier, nonce: parsed.nonce };
}

function samlClient(deps: Deps, config: SamlConfig, forceAuthn = false): SAML {
  return new SAML({
    entryPoint: config.SAML_ENTRY_POINT,
    issuer: config.SAML_ISSUER,
    idpCert: samlCertificates(config.SAML_CERT),
    forceAuthn,
    callbackUrl: config.SAML_CALLBACK_URL,
    wantAssertionsSigned: true,
    audience: config.SAML_ISSUER,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    cacheProvider: samlRequestCache(deps.db, deps.env.AUTH_ENCRYPTION_KEY),
  });
}

/**
 * One assertion, once: its id is kept for a day, longer than any assertion
 * is valid, and a second response carrying it is refused. The id is read
 * from the assertion whose signature was checked, never from the text the
 * browser posted.
 */
async function spendSamlAssertion(
  deps: Deps,
  profile: { getAssertion?: () => Record<string, unknown> },
): Promise<void> {
  const assertionId = samlAssertionId(profile.getAssertion?.());
  if (!assertionId) throw new AppError("invalid_credentials");
  const sealed = encryptSecret(
    "seen",
    deps.env.AUTH_ENCRYPTION_KEY,
    "sso-state",
  );
  try {
    await deps.db
      .insertInto("oauthStates")
      .values({
        stateHash: hashSessionToken(`saml-assertion:${assertionId}`),
        kind: "saml-assertion",
        verifierCiphertext: sealed.ciphertext,
        verifierNonce: sealed.nonce,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .execute();
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("invalid_credentials");
    throw error;
  }
}

/** The `ID` attribute of a parsed `<Assertion>`, whatever its prefix. */
export function samlAssertionId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const assertion: unknown = Object.values(parsed)[0];
  if (!assertion || typeof assertion !== "object" || !("$" in assertion)) {
    return null;
  }
  const attributes = assertion.$;
  if (!attributes || typeof attributes !== "object" || !("ID" in attributes)) {
    return null;
  }
  return typeof attributes.ID === "string" && attributes.ID.length > 0
    ? attributes.ID
    : null;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
let discovered:
  | {
      at: number;
      for: OidcConfig;
      config: oidc.Configuration;
      keys: JWTVerifyGetKey;
    }
  | undefined;

/**
 * The provider's configuration, discovered once an hour, and again as
 * soon as the issuer, the client, or its secret changes: each process
 * compares what it holds with what is configured now. openid-client
 * checks that the metadata names the configured issuer, then validates
 * every response: state, nonce, PKCE, audience, and expiry. The signature
 * of an ID token is checked too, against the keys the provider publishes:
 * keys it cannot fetch are a refused sign-in.
 */
async function oidcDiscovered(
  deps: Deps,
  env: OidcConfig,
): Promise<{ config: oidc.Configuration; keys: JWTVerifyGetKey }> {
  if (
    discovered &&
    discovered.for.OIDC_ISSUER === env.OIDC_ISSUER &&
    discovered.for.OIDC_CLIENT_ID === env.OIDC_CLIENT_ID &&
    discovered.for.OIDC_CLIENT_SECRET === env.OIDC_CLIENT_SECRET &&
    Date.now() - discovered.at < DISCOVERY_TTL_MS
  ) {
    return discovered;
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
  oidc.enableNonRepudiationChecks(config);
  const jwksUri = config.serverMetadata().jwks_uri;
  if (!jwksUri || (!testing && !jwksUri.startsWith("https://"))) {
    throw new AppError("invalid_oidc");
  }
  const keys = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: 5_000,
    ...(testing
      ? { [customFetch]: testing.fetch as unknown as typeof fetch }
      : {}),
  });
  discovered = { at: Date.now(), for: env, config, keys };
  return discovered;
}

async function oidcConfig(
  deps: Deps,
  env: OidcConfig,
): Promise<oidc.Configuration> {
  return (await oidcDiscovered(deps, env)).config;
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

/** What a provider vouched for, past the account it names. */
type Vouched = SignOn & {
  /** The provider said one factor was asked. */
  oneFactor: boolean;
  /** Reached by its address: the account's own factor comes first. */
  proofFirst: boolean;
};

/**
 * After the identity provider vouched for the person: a session, or first
 * AnyGridDB's own second step, when the policy asks for it (ADR 0043), when
 * the person is an administrator, when the provider itself says it asked a
 * single factor, for an account that has one here, or when the address alone
 * reached that account. Returns where the browser goes.
 */
async function finishSignIn(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  vouched: Vouched,
): Promise<string> {
  const { oneFactor, proofFirst, ...signOn } = vouched;
  const policy = await readSettings(deps.db);
  assertSignInAddressAllowed(policy.signInAllowlist, request.ip);
  const account = await deps.db
    .selectFrom("users")
    .select(["disabledAt", "isAdmin"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!account || account.disabledAt) throw new AppError("account_disabled");
  if (!account.isAdmin && policy.maintenance) {
    throw new AppError("instance_maintenance");
  }
  reply.setCookie(SSO_AGAIN_COOKIE, "", ssoAgainOptions(0));
  if (
    proofFirst ||
    ((policy.ssoMfa === "local" || account.isAdmin || oneFactor) &&
      (await factorMethods(deps.db, userId)).length > 0)
  ) {
    const challenge = await createLoginChallenge(deps.db, userId, signOn);
    reply.setCookie(
      MFA_COOKIE,
      challenge.token,
      sessionCookieOptions(challenge.expiresAt),
    );
    return "/login?mfa=1";
  }
  const session = await createSession(deps.db, userId, signOn);
  reply.setCookie(
    SESSION_COOKIE,
    session.token,
    sessionCookieOptions(session.expiresAt),
  );
  await signedIn(deps.db, request, userId, signOn.provider);
  return "/";
}

/** The person hears of a new way into an account that already existed. */
function tellOfBinding(deps: Deps, request: FastifyRequest) {
  return (userId: string) => {
    void sendSecurityNotice(
      { db: deps.db, env: deps.env, log: request.log },
      userId,
      { kind: "sso_linked" },
    );
  };
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
  app.get(
    "/auth/oidc/start",
    declaredRoute({ exception: "provider" }),
    async (request, reply) => {
      const { config: oidcEnv } = await resolveOidc(deps.db, deps.env);
      if (!oidcEnv) {
        return reply.code(404).send({ error: "Not found" });
      }
      const config = await oidcConfig(deps, oidcEnv);
      const verifier = oidc.randomPKCECodeVerifier();
      const nonce = oidc.randomNonce();
      const state = await saveState(
        deps.db,
        deps.env.AUTH_ENCRYPTION_KEY,
        "oidc",
        { verifier, nonce, browser: browserValue(request, reply, "oidc") },
      );
      const authorize = oidc.buildAuthorizationUrl(config, {
        redirect_uri: oidcEnv.OIDC_REDIRECT_URL,
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        ...(request.cookies[SSO_AGAIN_COOKIE] ? { prompt: "login" } : {}),
      });
      return reply.redirect(authorize.href);
    },
  );

  app.get(
    "/auth/oidc/callback",
    declaredRoute({ exception: "provider" }),
    async (request, reply) => {
      const { config: oidcEnv } = await resolveOidc(deps.db, deps.env);
      if (!oidcEnv) {
        return reply.code(404).send({ error: "Not found" });
      }
      const query = request.query as { code?: unknown; state?: unknown };
      let next: string;
      try {
        if (typeof query.code !== "string" || typeof query.state !== "string") {
          throw new AppError("challenge_expired");
        }
        const saved = await takeState(
          deps.db,
          deps.env.AUTH_ENCRYPTION_KEY,
          "oidc",
          query.state,
          request,
        );
        const config = await oidcConfig(deps, oidcEnv);
        // The callback as the provider called it: the registered redirect URL
        // with the query it appended (code, state, and maybe iss).
        const current = new URL(oidcEnv.OIDC_REDIRECT_URL);
        const raw = request.raw.url ?? "";
        current.search = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
        const tokens = await oidc.authorizationCodeGrant(config, current, {
          pkceCodeVerifier: saved.verifier,
          expectedNonce: saved.nonce,
          expectedState: query.state,
          idTokenExpected: true,
        });
        const claims = tokens.claims();
        if (!claims) throw new AppError("invalid_credentials");
        const email = typeof claims.email === "string" ? claims.email : null;
        // The subject finds a bound account, whatever the address says. A
        // first binding reads the address: only a boolean `true` reaches an
        // account that exists, and one marked unverified makes no account.
        const reached = await userForIdentity(
          deps.db,
          { provider: "oidc", issuer: claims.iss, subject: claims.sub },
          email,
          typeof claims.name === "string" ? claims.name : (email ?? ""),
          deps.env.ADMIN_EMAILS,
          {
            linkExisting: claims.email_verified === true,
            mayCreate: claims.email_verified !== false,
            otherProtocolLive:
              (await resolveSaml(deps.db, deps.env)).config !== null,
            onBound: tellOfBinding(deps, request),
          },
        );
        next = await finishSignIn(deps, request, reply, reached.userId, {
          provider: "oidc",
          proofFirst: reached.proofFirst,
          binding: reached.binding,
          sidHash:
            typeof claims.sid === "string"
              ? hashProviderSession(claims.iss, claims.sid)
              : null,
          oneFactor: oidcAnnouncesOneFactor(claims),
        });
      } catch (error) {
        request.log.warn({ err: error }, "authentication failed");
        await signInRefused(deps.db, request, "oidc", error);
        next = `/login?refused=${signOnRefusal(error)}`;
      }
      // Signed in or told why, the browser goes back to the app.
      return reply.redirect(next);
    },
  );

  // The provider, not a browser: it is told plainly whether this counted.
  app.post(
    "/auth/oidc/backchannel-logout",
    declaredRoute({ exception: "provider" }),
    async (request, reply) => {
      const { config: oidcEnv } = await resolveOidc(deps.db, deps.env);
      if (!oidcEnv) {
        return reply.code(404).send({ error: "Not found" });
      }
      void reply.header("cache-control", "no-store");
      try {
        const { keys } = await oidcDiscovered(deps, oidcEnv);
        const body = request.body as { logout_token?: unknown } | null;
        const claims = await verifyLogoutToken(body?.logout_token, {
          issuer: oidcEnv.OIDC_ISSUER,
          clientId: oidcEnv.OIDC_CLIENT_ID,
          keys,
        });
        await spendLogoutToken(
          deps.db,
          deps.env.AUTH_ENCRYPTION_KEY,
          oidcEnv.OIDC_ISSUER,
          claims.jti,
        );
        const ended = await endProviderSessions(deps.db, {
          issuer: oidcEnv.OIDC_ISSUER,
          ...(claims.subject ? { subject: claims.subject } : {}),
          ...(claims.sid ? { sid: claims.sid } : {}),
        });
        for (const tokenHash of ended) deps.closeSession?.(tokenHash);
        return await reply.code(200).send({ ok: true });
      } catch (error) {
        request.log.warn({ err: error }, "provider sign-out refused");
        return reply.code(400).send({ error: "invalid_request" });
      }
    },
  );

  app.get(
    "/auth/saml/start",
    declaredRoute({ exception: "provider" }),
    async (request, reply) => {
      const { config: samlEnv } = await resolveSaml(deps.db, deps.env);
      if (!samlEnv) {
        return reply.code(404).send({ error: "Not found" });
      }
      const state = await saveState(
        deps.db,
        deps.env.AUTH_ENCRYPTION_KEY,
        "saml",
        {
          verifier: randomBytes(16).toString("base64url"),
          nonce: randomBytes(16).toString("base64url"),
          browser: browserValue(request, reply, "saml"),
        },
      );
      const url = await samlClient(
        deps,
        samlEnv,
        Boolean(request.cookies[SSO_AGAIN_COOKIE]),
      ).getAuthorizeUrlAsync(state, undefined, {});
      return reply.redirect(url);
    },
  );

  app.post(
    "/auth/saml/acs",
    declaredRoute({ exception: "provider" }),
    async (request, reply) => {
      const { config: samlEnv } = await resolveSaml(deps.db, deps.env);
      if (!samlEnv) {
        return reply.code(404).send({ error: "Not found" });
      }
      let next: string;
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
          request,
        );
        const result = await samlClient(
          deps,
          samlEnv,
        ).validatePostResponseAsync({
          SAMLResponse: body.SAMLResponse,
        });
        const profile = result.profile;
        if (!profile) throw new AppError("invalid_credentials");
        const assertion = profile.getAssertion?.();
        if (!samlRecipientHolds(assertion, samlEnv.SAML_CALLBACK_URL)) {
          throw new AppError("invalid_credentials");
        }
        const mustEndAt = samlSessionEnd(assertion);
        const named = profile.email ?? profile.mail ?? profile.nameID;
        const email =
          typeof named === "string" && named.includes("@") ? named : null;
        await spendSamlAssertion(deps, profile);
        // A persistent NameID binds the account, and finds it from then on;
        // a transient or address-shaped one says nothing lasting. An
        // assertion does not say its address was verified: a first sign-in
        // reaches an account that exists only when an administrator says
        // this provider verifies addresses (ADR 0111).
        const reached = await userForIdentity(
          deps.db,
          {
            provider: "saml",
            issuer: profile.issuer,
            subject: stableNameId(profile.nameID, profile.nameIDFormat),
          },
          email,
          email ?? "",
          deps.env.ADMIN_EMAILS,
          {
            linkExisting: samlEnv.SAML_TRUST_ADDRESSES,
            otherProtocolLive:
              (await resolveOidc(deps.db, deps.env)).config !== null,
            onBound: tellOfBinding(deps, request),
          },
        );
        next = await finishSignIn(deps, request, reply, reached.userId, {
          provider: "saml",
          proofFirst: reached.proofFirst,
          binding: reached.binding,
          mustEndAt,
          oneFactor: samlAnnouncesOneFactor(assertion),
        });
      } catch (error) {
        request.log.warn({ err: error }, "authentication failed");
        await signInRefused(deps.db, request, "saml", error);
        next = `/login?refused=${signOnRefusal(error)}`;
      }
      // Signed in or told why, the browser goes back to the app.
      return reply.redirect(next);
    },
  );
}
