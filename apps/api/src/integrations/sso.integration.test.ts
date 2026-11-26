/**
 * Operator OIDC and SAML rows (ADR 0050): save, hide secrets, clear, env fallback.
 * Save proves discovery / certificate shape (ADR 0053).
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
} from "../trpc/caller.test-helpers.js";
import { clearOidcCache, resolveOidc } from "./oidc.js";
import { clearSamlCache, resolveSaml } from "./saml.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
/** Self-signed IdP cert for idp.example.org, valid through 2029. */
const CERT = `-----BEGIN CERTIFICATE-----
MIICsDCCAZgCCQDSM29vSTjITjANBgkqhkiG9w0BAQsFADAaMRgwFgYDVQQDDA9p
ZHAuZXhhbXBsZS5vcmcwHhcNMjYxMTExMTgzNTM3WhcNMjkwMjEzMTgzNTM3WjAa
MRgwFgYDVQQDDA9pZHAuZXhhbXBsZS5vcmcwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQDNMsi7uWLPZLoZhUmM++dVeT3GN+AaK6QkF+/G7S2FX4TEQ4Fa
irOG/DATGQ0/wo8VXL1mrjGRk64DDlffgOzehl+9grk6uVu3Q4Tqhf0CgKkW28YB
oQg+ZUjKW7QaKDN0X3AC4hD1Z5/1cFdnTs77M0pF0oHFTcBJqDq6gyFZ/KZkJvCv
BLg27IWfMtM2hFp0fAgXrvx8Mf0t40jibsieqreVPFYV34bSxjNG+tOIZXoHeyaT
jSZ332u3SyyuzZmMVZVK5N1E8ObTq5He2fE42dr9R6DMCi1uJhgdoJlKtA+9gCZK
CY60ABtcSkGNkJNx3O5h16OJdpfUJhP/BihtAgMBAAEwDQYJKoZIhvcNAQELBQAD
ggEBAIKNO9qfhQTZoLMSkoN0nGigdafVG/ewaT5L73R1VHBOmiI8ZxgRuXflDHRB
4xgql5ruKeJLoHtX3aG4mZbA1T/j1yNK14kDm7hRy0r6ns+9R31EanG5oek6hXco
zBxr0nb4SM0pwb5u5qW2nb8oN5mg+3Dj72eSIl9bcP2bZfJR5RZKpEeLB6xK/QTq
1WZT2atZqqOAC1YBXLp4BnUTj9Zt5p1V6PlRiR+MZHY8NqXZAU9Pgo3WtUpfS2Mv
EkZDArppZoEDr59zblzByjgGGuAUar+3u+7M28CH14YepWE2p/cJNM7z3d9bbBj8
yMWKMogCyoWrLW/RY6VH0iwp8/8=
-----END CERTIFICATE-----`;

/**
 * The identity provider, as the outbound service reaches it: a discovery
 * document at its well-known address, nothing anywhere else.
 */
vi.mock("../outbound/index.js", async (original) => ({
  ...(await original<typeof import("../outbound/index.js")>()),
  outboundFetch: () =>
    (async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.includes(".well-known/openid-configuration")) {
        return new Response("{}", { status: 404 });
      }
      return Response.json({
        issuer: "https://idp.example.org/",
        authorization_endpoint: "https://idp.example.org/authorize",
        token_endpoint: "https://idp.example.org/token",
      });
    }) as typeof fetch,
}));

describe("operator OIDC and SAML", () => {
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
  const admin = browser();

  beforeAll(async () => {
    const created = await createTestDatabase("sso_ui");
    db = created.db;
    close = created.close;
    await admin.signUpFirst({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    // A sensitive action asks for a proof again (ROADMAP #28): given
    // once here, it stands for the five minutes these tests take.
    await admin.call().admin.stepUp({ password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("stores OIDC with a sealed secret and derives the redirect", async () => {
    const saved = await admin.call().admin.oidc.update({
      issuer: "https://idp.example.org/",
      clientId: "anygriddb",
      clientSecret: "super-secret",
    });
    expect(saved.configured).toBe(true);
    expect(saved.redirectUrl).toBe(
      "https://grid.example.org/auth/oidc/callback",
    );
    expect(JSON.stringify(saved)).not.toContain("super-secret");

    clearOidcCache(db);
    const resolved = await resolveOidc(db, env);
    expect(resolved.source).toBe("database");
    expect(resolved.config?.OIDC_CLIENT_SECRET).toBe("super-secret");
    expect(resolved.config?.OIDC_REDIRECT_URL).toBe(
      "https://grid.example.org/auth/oidc/callback",
    );

    await admin.call().admin.oidc.clear();
    clearOidcCache(db);
    expect((await resolveOidc(db, env)).source).toBe("none");
  });

  it("stores SAML and derives the ACS URL", async () => {
    const saved = await admin.call().admin.saml.update({
      entryPoint: "https://idp.example.org/sso",
      issuer: "https://idp.example.org",
      idpCert: CERT,
    });
    expect(saved.configured).toBe(true);
    expect(saved.callbackUrl).toBe("https://grid.example.org/auth/saml/acs");
    expect(JSON.stringify(saved)).not.toContain("BEGIN CERTIFICATE");

    clearSamlCache(db);
    const resolved = await resolveSaml(db, env);
    expect(resolved.source).toBe("database");
    expect(resolved.config?.SAML_CERT).toContain("BEGIN CERTIFICATE");

    await admin.call().admin.saml.clear();
    clearSamlCache(db);
    expect((await resolveSaml(db, env)).source).toBe("none");
  });

  it("refuses an HTTP issuer, and a first save without a secret", async () => {
    expect(
      await errorCode(
        admin.call().admin.oidc.update({
          issuer: "http://idp.example.org/",
          clientId: "anygriddb",
          clientSecret: "super-secret",
        }),
      ),
    ).toBe("invalid_oidc");
    expect(
      await errorCode(
        admin.call().admin.oidc.update({
          issuer: "https://idp.example.org/",
          clientId: "anygriddb",
        }),
      ),
    ).toBe("invalid_oidc");
    clearOidcCache(db);
    expect((await resolveOidc(db, env)).source).toBe("none");
  });

  it("refuses HTTP SAML entry points and a bad certificate", async () => {
    expect(
      await errorCode(
        admin.call().admin.saml.update({
          entryPoint: "http://idp.example.org/sso",
          issuer: "https://idp.example.org",
          idpCert: CERT,
        }),
      ),
    ).toBe("invalid_saml");
    expect(
      await errorCode(
        admin.call().admin.saml.update({
          entryPoint: "https://idp.example.org/sso",
          issuer: "https://idp.example.org",
          idpCert: "not-a-certificate",
        }),
      ),
    ).toBe("invalid_saml");
  });

  it("refuses SSO-only without a provider, then allows it once OIDC is saved", async () => {
    expect(
      await errorCode(admin.call().admin.updateSettings({ ssoOnly: true })),
    ).toBe("sso_required");
    await admin.call().admin.oidc.update({
      issuer: "https://idp.example.org/",
      clientId: "anygriddb",
      clientSecret: "super-secret",
    });
    const settings = await admin.call().admin.updateSettings({ ssoOnly: true });
    expect(settings.ssoOnly).toBe(true);
    await admin.call().admin.updateSettings({ ssoOnly: false });
    await admin.call().admin.oidc.clear();
  });

  it("lets the environment's providers win, shows them, and does not change them", async () => {
    const held = {
      OIDC_ISSUER: "https://env-idp.example.org/",
      OIDC_CLIENT_ID: "from-env",
      OIDC_CLIENT_SECRET: "env-secret",
      OIDC_REDIRECT_URL: "https://grid.example.org/auth/oidc/callback",
      SAML_ENTRY_POINT: "https://env-idp.example.org/sso",
      SAML_ISSUER: "https://env-idp.example.org",
      SAML_CERT: CERT,
      SAML_CALLBACK_URL: "https://grid.example.org/auth/saml/acs",
    };
    // Three of four is not a provider: the page still decides.
    Object.assign(env, { ...held, OIDC_CLIENT_SECRET: undefined });
    expect((await resolveOidc(db, env)).source).toBe("none");
    Object.assign(env, held);
    try {
      expect((await resolveOidc(db, env)).source).toBe("env");
      expect((await resolveSaml(db, env)).source).toBe("env");

      const oidc = await admin.call().admin.oidc.get();
      expect(oidc).toMatchObject({
        source: "env",
        ready: true,
        configured: false,
        issuer: "https://env-idp.example.org/",
        clientId: "from-env",
        hasClientSecret: true,
        redirectUrl: "https://grid.example.org/auth/oidc/callback",
      });
      expect(JSON.stringify(oidc)).not.toContain("env-secret");
      expect(
        await errorCode(
          admin.call().admin.oidc.update({
            issuer: "https://idp.example.org/",
            clientId: "anygriddb",
            clientSecret: "super-secret",
          }),
        ),
      ).toBe("set_by_environment");

      const saml = await admin.call().admin.saml.get();
      expect(saml).toMatchObject({
        source: "env",
        ready: true,
        configured: false,
        entryPoint: "https://env-idp.example.org/sso",
        issuer: "https://env-idp.example.org",
        callbackUrl: "https://grid.example.org/auth/saml/acs",
      });
      expect(JSON.stringify(saml)).not.toContain("BEGIN CERTIFICATE");
      expect(
        await errorCode(
          admin.call().admin.saml.update({
            entryPoint: "https://idp.example.org/sso",
            issuer: "https://idp.example.org",
            idpCert: CERT,
          }),
        ),
      ).toBe("set_by_environment");

      // Nothing was saved behind the refusals.
      for (const table of ["instanceOidc", "instanceSaml"] as const) {
        expect(
          await db.selectFrom(table).select("id").executeTakeFirst(),
        ).toBeUndefined();
      }
      // The environment's provider counts for requiring single sign-on.
      const settings = await admin
        .call()
        .admin.updateSettings({ ssoOnly: true });
      expect(settings.ssoOnly).toBe(true);
      await admin.call().admin.updateSettings({ ssoOnly: false });
    } finally {
      for (const name of Object.keys(held)) {
        Reflect.deleteProperty(env, name);
      }
    }
    expect((await resolveOidc(db, env)).source).toBe("none");
    expect((await resolveSaml(db, env)).source).toBe("none");
  });

  it("leaves the largest attachment to the environment when it sets one", async () => {
    Object.assign(env, { ATTACHMENT_MAX_BYTES: 5_242_880 });
    try {
      expect(
        await errorCode(
          admin.call().admin.updateSettings({ attachmentMaxBytes: 1_048_576 }),
        ),
      ).toBe("set_by_environment");
      // Another setting of the same page is still saved.
      const kept = await admin.call().admin.updateSettings({ trashDays: 14 });
      expect(kept.trashDays).toBe(14);
      expect(kept.attachmentMaxBytes).toBeNull();
    } finally {
      Reflect.deleteProperty(env, "ATTACHMENT_MAX_BYTES");
    }
    const saved = await admin
      .call()
      .admin.updateSettings({ attachmentMaxBytes: 1_048_576, trashDays: 30 });
    expect(saved.attachmentMaxBytes).toBe(1_048_576);
    await admin.call().admin.updateSettings({ attachmentMaxBytes: null });
  });
});
