/**
 * Operator OIDC and SAML rows (ADR 0050): save, hide secrets, clear, env fallback.
 * Save proves discovery / certificate shape (ADR 0053).
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

function mockOidcDiscovery(): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.includes(".well-known/openid-configuration")) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        issuer: "https://idp.example.org/",
        authorization_endpoint: "https://idp.example.org/authorize",
        token_endpoint: "https://idp.example.org/token",
      }),
    };
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

describe("operator OIDC and SAML", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let restoreFetch: (() => void) | undefined;
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
    restoreFetch = mockOidcDiscovery();
    const created = await createTestDatabase("sso_ui");
    db = created.db;
    close = created.close;
    await admin.call().auth.signup({
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
    restoreFetch?.();
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
});
