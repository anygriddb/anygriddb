/**
 * Operator OIDC and SAML rows (ADR 0050): save, hide secrets, clear, env fallback.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const CERT = `-----BEGIN CERTIFICATE-----
MIIBtjCCAVugAwIBAgIUTest
-----END CERTIFICATE-----`;

describe("operator OIDC and SAML", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;

  const hub = { closeUser: () => 0, closeAllBut: () => 0 };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();

  beforeAll(async () => {
    const created = await createTestDatabase("sso_ui");
    db = created.db;
    close = created.close;
    await admin.call().auth.signup({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
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

  it("refuses HTTP SAML entry points", async () => {
    expect(
      await errorCode(
        admin.call().admin.saml.update({
          entryPoint: "http://idp.example.org/sso",
          issuer: "https://idp.example.org",
          idpCert: CERT,
        }),
      ),
    ).toBe("invalid_saml");
  });
});
