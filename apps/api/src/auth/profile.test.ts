import { describe, expect, it } from "vitest";
import { profileManaged } from "./profile.js";

describe("profileManaged", () => {
  it("leaves the name to an identity provider that provisions the account", () => {
    expect(profileManaged({ scimUserName: "ada", deprovisionedAt: null })).toBe(
      true,
    );
  });

  it("lets the person rename an account no provider keeps", () => {
    expect(profileManaged({ scimUserName: null, deprovisionedAt: null })).toBe(
      false,
    );
    // Deprovisioned: the provider let it go.
    expect(
      profileManaged({
        scimUserName: "ada",
        deprovisionedAt: new Date("2026-11-01T00:00:00Z"),
      }),
    ).toBe(false);
  });
});
