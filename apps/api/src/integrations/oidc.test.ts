import { describe, expect, it } from "vitest";
import { AppError } from "@anygriddb/core";
import {
  oidcRedirectUrl,
  oidcUpdateSchema,
  proveOidcIssuer,
  publicOidc,
} from "./oidc.js";

describe("operator OIDC", () => {
  it("derives the redirect URL from PUBLIC_URL", () => {
    expect(oidcRedirectUrl("https://app.example.org/")).toBe(
      "https://app.example.org/auth/oidc/callback",
    );
    expect(oidcRedirectUrl("https://app.example.org")).toBe(
      "https://app.example.org/auth/oidc/callback",
    );
  });

  it("shows a saved row without its secret, and nothing for none", () => {
    const shown = publicOidc(
      {
        issuer: "https://idp.example.org",
        clientId: "client",
        clientSecretCiphertext: Buffer.from("sealed"),
        clientSecretNonce: Buffer.from("nonce"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedBy: null,
      },
      "https://app.example.org",
    );
    expect(shown).toEqual({
      configured: true,
      issuer: "https://idp.example.org",
      clientId: "client",
      hasClientSecret: true,
      redirectUrl: "https://app.example.org/auth/oidc/callback",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(publicOidc(null, "https://app.example.org")).toMatchObject({
      configured: false,
      hasClientSecret: false,
      redirectUrl: null,
    });
  });

  it("accepts an issuer and a client, and refuses what is not one", () => {
    const input = { issuer: "https://idp.example.org/", clientId: "client" };
    expect(oidcUpdateSchema.safeParse(input).success).toBe(true);
    expect(
      oidcUpdateSchema.safeParse({ ...input, clientSecret: "secret" }).success,
    ).toBe(true);
    expect(
      oidcUpdateSchema.safeParse({ ...input, issuer: "idp" }).success,
    ).toBe(false);
    expect(
      oidcUpdateSchema.safeParse({ ...input, clientId: " " }).success,
    ).toBe(false);
    expect(
      oidcUpdateSchema.safeParse({ ...input, clientSecret: "" }).success,
    ).toBe(false);
    expect(
      oidcUpdateSchema.safeParse({ ...input, redirectUrl: "https://x.example" })
        .success,
    ).toBe(false);
  });

  it("proves discovery over HTTPS and refuses a broken document", async () => {
    await proveOidcIssuer("https://idp.example.org/", {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          authorization_endpoint: "https://idp.example.org/a",
          token_endpoint: "https://idp.example.org/t",
        }),
      }),
    });
    await expect(
      proveOidcIssuer("http://idp.example.org/", {
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({}),
        }),
      }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      proveOidcIssuer("https://idp.example.org/", {
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ authorization_endpoint: "https://x" }),
        }),
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
