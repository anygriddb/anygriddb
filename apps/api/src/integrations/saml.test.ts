import { describe, expect, it } from "vitest";
import { AppError } from "@anygriddb/core";
import {
  proveSamlCertificate,
  publicSaml,
  samlCallbackUrl,
  samlUpdateSchema,
} from "./saml.js";

const VALID_CERT = `-----BEGIN CERTIFICATE-----
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

  it("accepts a valid PEM and refuses garbage", () => {
    expect(() => proveSamlCertificate(VALID_CERT)).not.toThrow();
    expect(() => proveSamlCertificate("not-pem")).toThrow(AppError);
  });
});
