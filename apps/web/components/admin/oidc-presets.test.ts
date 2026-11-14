import { describe, expect, it } from "vitest";
import { needsTenant, OIDC_PRESETS, TENANT_PLACEHOLDER } from "./oidc-presets";

const issuerOf = (id: string) =>
  OIDC_PRESETS.find((preset) => preset.id === id)?.issuer ?? "";

describe("the issuers Administration fills", () => {
  it("fills Google's whole", () => {
    expect(issuerOf("google")).toBe("https://accounts.google.com");
    expect(needsTenant(issuerOf("google"))).toBe(false);
  });

  it("leaves Microsoft's to finish with the directory's ID", () => {
    const issuer = issuerOf("microsoft");
    expect(needsTenant(issuer)).toBe(true);
    const finished = issuer.replace(
      TENANT_PLACEHOLDER,
      "9188040d-6c67-4c5b-b112-36a304b66dad",
    );
    expect(needsTenant(finished)).toBe(false);
    expect(new URL(finished).pathname).toBe(
      "/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0",
    );
  });

  it("names no shared address, which no sign-in can check", () => {
    for (const { issuer } of OIDC_PRESETS) {
      expect(issuer).toMatch(/^https:\/\//);
      expect(issuer).not.toMatch(/\/(common|organizations|consumers)\//);
    }
  });
});
