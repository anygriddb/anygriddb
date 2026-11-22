/**
 * A sign-on against two real protocols: which account it reaches, what it
 * proves, how long its session lasts, and what ends it.
 */
import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Env } from "../env.js";
import { acceptFormBodies } from "../http.js";
import { clearSamlCache } from "../integrations/saml.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { assertEnrolled, loadBindings } from "./access.js";
import { registerEnterpriseAuth, SSO_BROWSER_COOKIES } from "./enterprise.js";
import { keyRing } from "./key-ring.js";
import { hashSessionToken, SESSION_COOKIE } from "./session.js";
import {
  oidcProvider,
  samlIdentity,
  samlRequestOf,
  samlResponse,
  type AssertionInput,
  type SamlIdentity,
} from "./sso-providers.test-helpers.js";
import { saveTotpSecret } from "./totp.js";
import { generateTotpSecret } from "./totp-code.js";

const suffix = randomBytes(6).toString("hex");
const OIDC_ISSUER = `http://idp-${suffix}.test`;
const SAML_ISSUER = `https://saml-idp-${suffix}.example.org`;
const CLIENT = "anygriddb";
const APP = "http://localhost:4000";
const ACS = `${APP}/auth/saml/acs`;
const SP = `urn:grid:${suffix}`;

const address = (label: string) =>
  `${label}-${randomBytes(4).toString("hex")}-${suffix}@example.org`;

describe("single sign-on, end to end", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let oidc: Awaited<ReturnType<typeof oidcProvider>>;
  let current: SamlIdentity;
  let next: SamlIdentity;
  let stranger: SamlIdentity;
  let operator = "";
  const closed: string[] = [];
  const key = keyRing(randomBytes(32));
  const env = {
    AUTH_ENCRYPTION_KEY: key,
    PUBLIC_URL: APP,
    OIDC_ISSUER,
    OIDC_CLIENT_ID: CLIENT,
    OIDC_CLIENT_SECRET: "secret",
    OIDC_REDIRECT_URL: `${APP}/auth/oidc/callback`,
    SAML_ENTRY_POINT: "https://idp.example.org/sso",
    SAML_ISSUER: SP,
    SAML_CERT: "",
    SAML_CALLBACK_URL: ACS,
    SAML_TRUST_ADDRESSES: false,
  } as unknown as Env;

  beforeAll(async () => {
    const created = await createTestDatabase("sso_sessions");
    db = created.db;
    close = created.close;
    operator = (
      await db
        .insertInto("users")
        .values({
          email: `operator-${suffix}@example.org`,
          displayName: "Olga Operator",
          isAdmin: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await writeSettings(db, operator, { signup: "open" });
    oidc = await oidcProvider(OIDC_ISSUER, CLIENT);
    [current, next, stranger] = await Promise.all([
      samlIdentity(),
      samlIdentity(),
      samlIdentity(),
    ]);
    env.SAML_CERT = current.cert;
    app = Fastify();
    await app.register(cookie);
    acceptFormBodies(app);
    registerEnterpriseAuth(app, {
      env,
      db,
      oidcTesting: { fetch: oidc.fetch },
      closeSession: (hash) => closed.push(hash),
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await close?.();
  });

  beforeEach(() => {
    oidc.reset();
    env.SAML_CERT = current.cert;
    env.SAML_TRUST_ADDRESSES = false;
    clearSamlCache(db);
  });

  const cookies = (response: {
    cookies: Array<{ name: string; value: string }>;
  }) =>
    Object.fromEntries(
      response.cookies
        .filter((item) => item.value !== "")
        .map((item) => [item.name, item.value]),
    );

  async function oidcSignIn(
    claims: Record<string, unknown>,
    jar: Record<string, string> = {},
  ) {
    const started = await app.inject({
      method: "GET",
      url: "/auth/oidc/start",
      cookies: jar,
    });
    const location = new URL(String(started.headers.location));
    const state = location.searchParams.get("state") ?? "";
    oidc.state.nonce = location.searchParams.get("nonce") ?? "";
    oidc.state.claims = claims;
    const back = await app.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=c-${randomBytes(4).toString("hex")}&state=${encodeURIComponent(state)}`,
      cookies: { ...jar, ...cookies(started) },
    });
    return { back, prompt: location.searchParams.get("prompt") };
  }

  async function samlSignIn(
    input: Partial<AssertionInput> & { nameId: string },
    jar: Record<string, string> = {},
  ) {
    const started = await app.inject({
      method: "GET",
      url: "/auth/saml/start",
      cookies: jar,
    });
    const asked = samlRequestOf(String(started.headers.location));
    const back = await app.inject({
      method: "POST",
      url: "/auth/saml/acs",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      cookies: {
        ...jar,
        [SSO_BROWSER_COOKIES.saml]:
          cookies(started)[SSO_BROWSER_COOKIES.saml] ?? "",
      },
      payload: new URLSearchParams({
        SAMLResponse: samlResponse({
          identity: current,
          issuer: SAML_ISSUER,
          audience: SP,
          acs: ACS,
          inResponseTo: asked.id,
          ...input,
        }),
        RelayState: asked.relayState,
      }).toString(),
    });
    return { back, forceAuthn: asked.forceAuthn };
  }

  const opened = (response: {
    cookies: Array<{ name: string; value: string }>;
  }) => cookies(response)[SESSION_COOKIE] ?? null;

  const account = async (label: string, isAdmin = false) => {
    const email = address(label);
    const row = await db
      .insertInto("users")
      .values({ email, displayName: label, isAdmin })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { email, id: row.id };
  };

  const idOf = async (email: string) =>
    (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", email)
        .executeTakeFirst()
    )?.id;

  const sessionRow = (token: string) =>
    db
      .selectFrom("sessions")
      .selectAll()
      .where("tokenHash", "=", hashSessionToken(token))
      .executeTakeFirst();

  const giveFactor = (userId: string) =>
    saveTotpSecret(db, userId, generateTotpSecret(), key, 0);

  describe("the signature of an OIDC token", () => {
    const claims = () => ({ email: address("sig"), email_verified: true });

    it("takes a token signed by the published key", async () => {
      expect(opened((await oidcSignIn(claims())).back)).not.toBeNull();
    });

    it("refuses a key it does not publish, under a name it knows", async () => {
      oidc.state.signer = await oidc.newKey("k1");
      expect(opened((await oidcSignIn(claims())).back)).toBeNull();
    });

    it("refuses a key under a name it does not know", async () => {
      oidc.state.signer = await oidc.newKey("unknown");
      oidc.state.headerKid = "unknown";
      expect(opened((await oidcSignIn(claims())).back)).toBeNull();
    });

    it("refuses a damaged signature", async () => {
      oidc.state.flipSignature = true;
      expect(opened((await oidcSignIn(claims())).back)).toBeNull();
    });

    it("follows the provider through a rotation of its key", async () => {
      const rotated = await oidc.newKey("k2");
      oidc.state.keys = [rotated];
      oidc.state.signer = rotated;
      oidc.state.headerKid = "k2";
      // The library asks for the keys again at most once a minute.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
      try {
        expect(opened((await oidcSignIn(claims())).back)).not.toBeNull();
      } finally {
        // Back to the first key, read again, for the tests after this one.
        oidc.reset();
        vi.setSystemTime(Date.now() + 61_000);
        await oidcSignIn(claims());
        vi.useRealTimers();
      }
    });
  });

  describe("the subject first, the address for a first binding only", () => {
    it("lets a bound subject in though its address is no longer verified", async () => {
      const email = address("bound");
      const sub = `bound-${randomBytes(4).toString("hex")}`;
      await oidcSignIn({ sub, email, email_verified: true });
      const id = await idOf(email);
      const { back } = await oidcSignIn({ sub, email, email_verified: false });
      const token = opened(back);
      expect(token).not.toBeNull();
      expect((await sessionRow(token ?? ""))?.userId).toBe(id);
    });

    it("lets a bound subject in with no address at all", async () => {
      const email = address("noaddress");
      const sub = `noaddress-${randomBytes(4).toString("hex")}`;
      await oidcSignIn({ sub, email, email_verified: true });
      const { back } = await oidcSignIn({ sub });
      expect(opened(back)).not.toBeNull();
    });

    it("refuses a new subject with an unverified address, and makes nothing", async () => {
      const taken = await account("taken");
      const sub = `new-${randomBytes(4).toString("hex")}`;
      const first = await oidcSignIn({
        sub,
        email: taken.email,
        email_verified: false,
      });
      expect(first.back.headers.location).toBe("/login?refused=sso_refused");
      const fresh = address("fresh");
      const second = await oidcSignIn({
        sub,
        email: fresh,
        email_verified: false,
      });
      expect(opened(second.back)).toBeNull();
      expect(await idOf(fresh)).toBeUndefined();
    });

    it("binds a first SAML sign-in when the provider is trusted", async () => {
      env.SAML_TRUST_ADDRESSES = true;
      clearSamlCache(db);
      const person = await account("first-saml");
      const nameId = `first-${randomBytes(4).toString("hex")}`;
      const { back } = await samlSignIn({ nameId, email: person.email });
      const token = opened(back);
      expect(token).not.toBeNull();
      expect((await sessionRow(token ?? ""))?.userId).toBe(person.id);
    });

    it("keeps an account bound through OIDC from another SAML subject, trusted or not", async () => {
      env.SAML_TRUST_ADDRESSES = true;
      clearSamlCache(db);
      const email = address("oidc-bound");
      await oidcSignIn({
        sub: `owner-${randomBytes(4).toString("hex")}`,
        email,
        email_verified: true,
      });
      const persistent = await samlSignIn({
        nameId: `intruder-${randomBytes(4).toString("hex")}`,
        email,
      });
      expect(opened(persistent.back)).toBeNull();
      const transient = await samlSignIn({
        nameId: email,
        nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        email,
      });
      expect(opened(transient.back)).toBeNull();
    });

    it("lets a provider replaced by another bind the account anew", async () => {
      const email = address("moved");
      const id = (await account("moved-account")).id;
      await db
        .updateTable("users")
        .set({ email })
        .where("id", "=", id)
        .execute();
      await db
        .insertInto("ssoIdentities")
        .values({
          provider: "oidc",
          issuer: "https://retired.example.org",
          subject: "old",
          userId: id,
        })
        .execute();
      const { back } = await oidcSignIn({
        sub: `new-${randomBytes(4).toString("hex")}`,
        email,
        email_verified: true,
      });
      const token = opened(back);
      expect((await sessionRow(token ?? ""))?.userId).toBe(id);
    });
  });

  describe("what a provider's second factor is worth", () => {
    const person = async (label: string, isAdmin = false) => {
      const email = address(label);
      const sub = `${label}-${randomBytes(4).toString("hex")}`;
      await oidcSignIn({ sub, email, email_verified: true });
      const id = (await idOf(email)) ?? "";
      if (isAdmin) {
        await db
          .updateTable("users")
          .set({ isAdmin: true })
          .where("id", "=", id)
          .execute();
      }
      return { email, sub, id };
    };

    beforeAll(async () => {
      await writeSettings(db, operator, { ssoMfa: "provider" });
    });
    afterAll(async () => {
      await writeSettings(db, operator, { ssoMfa: "local" });
    });

    it("keeps an administrator's own factor, whatever the provider says", async () => {
      const admin = await person("mfa-admin", true);
      await giveFactor(admin.id);
      const { back } = await oidcSignIn({
        sub: admin.sub,
        email: admin.email,
        email_verified: true,
        amr: ["pwd", "otp"],
      });
      expect(back.headers.location).toBe("/login?mfa=1");
      expect(opened(back)).toBeNull();
    });

    it("asks an administrator with no factor to enrol one", async () => {
      const admin = await person("mfa-noadmin", true);
      await expect(
        assertEnrolled(
          db,
          { id: admin.id, isAdmin: true },
          await loadBindings(db, admin.id),
        ),
      ).rejects.toMatchObject({ code: "mfa_enrollment_required" });
    });

    it("keeps a person's own factor when the provider says it asked one", async () => {
      const someone = await person("mfa-pwd");
      await giveFactor(someone.id);
      const { back } = await oidcSignIn({
        sub: someone.sub,
        email: someone.email,
        email_verified: true,
        amr: ["pwd"],
      });
      expect(back.headers.location).toBe("/login?mfa=1");
    });

    it("trusts a provider that says it asked two", async () => {
      const someone = await person("mfa-two");
      await giveFactor(someone.id);
      const { back } = await oidcSignIn({
        sub: someone.sub,
        email: someone.email,
        email_verified: true,
        amr: ["pwd", "otp"],
      });
      expect(opened(back)).not.toBeNull();
    });

    it("keeps the instance's choice when the provider says nothing", async () => {
      const someone = await person("mfa-silent");
      await giveFactor(someone.id);
      const { back } = await oidcSignIn({
        sub: someone.sub,
        email: someone.email,
        email_verified: true,
      });
      expect(opened(back)).not.toBeNull();
    });

    it("keeps a SAML person's own factor on a password assertion", async () => {
      env.SAML_TRUST_ADDRESSES = true;
      clearSamlCache(db);
      const nameId = `saml-pwd-${randomBytes(4).toString("hex")}`;
      const email = address("saml-pwd");
      await samlSignIn({ nameId, email });
      const id = (await idOf(email)) ?? "";
      await giveFactor(id);
      const { back } = await samlSignIn({
        nameId,
        email,
        classRef: "urn:oasis:names:tc:SAML:2.0:ac:classes:Password",
      });
      expect(back.headers.location).toBe("/login?mfa=1");
    });
  });

  describe("a SAML assertion's own limits", () => {
    const signIn = (input: Partial<AssertionInput> = {}) =>
      samlSignIn({
        nameId: `limits-${randomBytes(4).toString("hex")}`,
        email: address("limits"),
        ...input,
      });

    it("takes the address of this service as recipient", async () => {
      expect(opened((await signIn()).back)).not.toBeNull();
    });

    it("refuses an assertion meant for another service", async () => {
      const { back } = await signIn({
        recipient: "https://other.example.org/acs",
      });
      expect(back.headers.location).toBe("/login?refused=sso_refused");
      expect(opened(back)).toBeNull();
    });

    it("takes an assertion that names no recipient", async () => {
      expect(opened((await signIn({ recipient: null })).back)).not.toBeNull();
    });

    it("ends the session when the provider says", async () => {
      const end = new Date(Date.now() + 120_000);
      const token = opened((await signIn({ sessionNotOnOrAfter: end })).back);
      const row = await sessionRow(token ?? "");
      expect(row?.mustEndAt?.getTime()).toBe(end.getTime());
      expect(row?.expiresAt.getTime()).toBeLessThanOrEqual(end.getTime());
    });

    it("refuses a session the provider already ended", async () => {
      const { back } = await signIn({
        sessionNotOnOrAfter: new Date(Date.now() - 1_000),
      });
      expect(opened(back)).toBeNull();
    });

    it("keeps the instance's lifetime when the provider sets none", async () => {
      const token = opened((await signIn()).back);
      expect((await sessionRow(token ?? ""))?.mustEndAt).toBeNull();
    });

    it("keeps the end through the second step", async () => {
      env.SAML_TRUST_ADDRESSES = true;
      clearSamlCache(db);
      const nameId = `step-${randomBytes(4).toString("hex")}`;
      const email = address("step");
      await signIn({ nameId, email });
      const id = (await idOf(email)) ?? "";
      await giveFactor(id);
      const end = new Date(Date.now() + 120_000);
      const { back } = await signIn({
        nameId,
        email,
        sessionNotOnOrAfter: end,
      });
      expect(back.headers.location).toBe("/login?mfa=1");
      const challenge = await db
        .selectFrom("loginChallenges")
        .selectAll()
        .where("userId", "=", id)
        .executeTakeFirstOrThrow();
      expect(challenge.signOn).toBe("saml");
      expect(challenge.mustEndAt?.getTime()).toBe(end.getTime());
    });
  });

  describe("a certificate's rotation", () => {
    const signedBy = (identity: SamlIdentity) =>
      samlSignIn({
        identity,
        nameId: `rotate-${randomBytes(4).toString("hex")}`,
        email: address("rotate"),
      });

    it("takes either of two certificates, in either order", async () => {
      for (const field of [
        `${current.cert}\n${next.cert}`,
        `${next.cert}\n${current.cert}`,
      ]) {
        env.SAML_CERT = field;
        clearSamlCache(db);
        expect(opened((await signedBy(current)).back)).not.toBeNull();
        expect(opened((await signedBy(next)).back)).not.toBeNull();
      }
    });

    it("refuses a signature by a key the field does not hold", async () => {
      env.SAML_CERT = `${current.cert}\n${next.cert}`;
      clearSamlCache(db);
      expect(opened((await signedBy(stranger)).back)).toBeNull();
    });
  });

  describe("signing in again after signing out", () => {
    it("asks the provider for the password again, once", async () => {
      const again = { "__Host-ag_sso_again": "1" };
      const claims = { email: address("again"), email_verified: true };
      const first = await oidcSignIn(claims, again);
      expect(first.prompt).toBe("login");
      const cleared = first.back.cookies.find(
        (item) => item.name === "__Host-ag_sso_again",
      );
      expect(cleared?.value).toBe("");
      expect((await oidcSignIn(claims)).prompt).toBeNull();
    });

    it("asks a SAML provider the same", async () => {
      const nameId = `again-${randomBytes(4).toString("hex")}`;
      const email = address("again-saml");
      const forced = await samlSignIn(
        { nameId, email },
        { "__Host-ag_sso_again": "1" },
      );
      expect(forced.forceAuthn).toBe(true);
      expect((await samlSignIn({ nameId, email })).forceAuthn).toBe(false);
    });
  });

  describe("a sign-out the provider sends", () => {
    const post = (token: string) =>
      app.inject({
        method: "POST",
        url: "/auth/oidc/backchannel-logout",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ logout_token: token }).toString(),
      });

    const signedIn = async (claims: Record<string, unknown> = {}) => {
      const email = address("logout");
      const sub = `logout-${randomBytes(4).toString("hex")}`;
      const { back } = await oidcSignIn({
        sub,
        email,
        email_verified: true,
        ...claims,
      });
      const token = opened(back) ?? "";
      expect(token).not.toBe("");
      return { sub, email, token };
    };

    it("ends every session of the subject", async () => {
      const person = await signedIn();
      const other = opened(
        (
          await oidcSignIn({
            sub: person.sub,
            email: person.email,
            email_verified: true,
          })
        ).back,
      );
      const answer = await post(await oidc.logoutToken({ sub: person.sub }));
      expect(answer.statusCode).toBe(200);
      expect(answer.headers["cache-control"]).toBe("no-store");
      expect(await sessionRow(person.token)).toBeUndefined();
      expect(await sessionRow(other ?? "")).toBeUndefined();
      expect(closed).toContain(hashSessionToken(person.token));
    });

    it("ends only the session the provider names", async () => {
      const person = await signedIn({ sid: "one" });
      const kept = opened(
        (
          await oidcSignIn({
            sub: person.sub,
            email: person.email,
            email_verified: true,
            sid: "two",
          })
        ).back,
      );
      const answer = await post(await oidc.logoutToken({ sid: "one" }));
      expect(answer.statusCode).toBe(200);
      expect(await sessionRow(person.token)).toBeUndefined();
      expect(await sessionRow(kept ?? "")).toBeDefined();
    });

    it("takes a token once", async () => {
      const person = await signedIn();
      const token = await oidc.logoutToken({ sub: person.sub });
      expect((await post(token)).statusCode).toBe(200);
      expect((await post(token)).statusCode).toBe(400);
    });

    it("refuses what the provider did not sign, or not for this client", async () => {
      const person = await signedIn();
      const refused = [
        await oidc.logoutToken(
          { sub: person.sub },
          { key: await oidc.newKey("k1") },
        ),
        await oidc.logoutToken({ sub: person.sub }, { audience: "another" }),
        await oidc.logoutToken({ sub: person.sub, nonce: "n" }),
        await oidc.logoutToken({ sub: person.sub, events: {} }),
        await oidc.logoutToken({}),
        "not-a-token",
      ];
      for (const token of refused) {
        expect((await post(token)).statusCode).toBe(400);
      }
      expect(await sessionRow(person.token)).toBeDefined();
    });
  });
});
