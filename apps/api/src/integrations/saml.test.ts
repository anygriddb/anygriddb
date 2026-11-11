import { describe, expect, it } from "vitest";
import { publicSaml, samlCallbackUrl, samlUpdateSchema } from "./saml.js";

describe("operator SAML", () => {
  it("derives the ACS URL from PUBLIC_URL", () => {
    expect(samlCallbackUrl("https://app.example.org")).toBe(
      "https://app.example.org/auth/saml/acs",
    );
    expect(samlCallbackUrl("https://app.example.org//")).toBe(
      "https://app.example.org/auth/saml/acs",
    );
  });

  it("shows a saved row without its certificate, and nothing for none", () => {
    const shown = publicSaml(
      {
        entryPoint: "https://idp.example.org/sso",
        issuer: "https://idp.example.org",
        idpCert: "-----BEGIN CERTIFICATE-----",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedBy: null,
      },
      "https://app.example.org",
    );
    expect(shown).toEqual({
      configured: true,
      entryPoint: "https://idp.example.org/sso",
      issuer: "https://idp.example.org",
      hasIdpCert: true,
      callbackUrl: "https://app.example.org/auth/saml/acs",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(publicSaml(null, "https://app.example.org")).toMatchObject({
      configured: false,
      hasIdpCert: false,
      callbackUrl: null,
    });
  });

  it("accepts an entry point and an issuer, and refuses what is not one", () => {
    const input = {
      entryPoint: "https://idp.example.org/sso",
      issuer: "https://idp.example.org",
    };
    expect(samlUpdateSchema.safeParse(input).success).toBe(true);
    expect(
      samlUpdateSchema.safeParse({ ...input, entryPoint: "sso" }).success,
    ).toBe(false);
    expect(samlUpdateSchema.safeParse({ ...input, issuer: "" }).success).toBe(
      false,
    );
    expect(samlUpdateSchema.safeParse({ ...input, idpCert: " " }).success).toBe(
      false,
    );
  });
});
