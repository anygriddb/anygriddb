import { describe, expect, it } from "vitest";
import { AppError } from "@anygriddb/core";
import {
  assertLocalSignInAllowed,
  assertPasswordSignupAllowed,
} from "./sso-only.js";

describe("SSO-only gates", () => {
  it("lets anyone through when SSO-only is off", () => {
    expect(() =>
      assertLocalSignInAllowed({ ssoOnly: false }, { isAdmin: false }),
    ).not.toThrow();
    expect(() => assertPasswordSignupAllowed({ ssoOnly: false })).not.toThrow();
  });

  it("lets administrators keep a password when SSO-only is on", () => {
    expect(() =>
      assertLocalSignInAllowed({ ssoOnly: true }, { isAdmin: true }),
    ).not.toThrow();
  });

  it("refuses password sign-up and non-admin password sign-in when on", () => {
    expect(() => assertPasswordSignupAllowed({ ssoOnly: true })).toThrow(
      AppError,
    );
    expect(() =>
      assertLocalSignInAllowed({ ssoOnly: true }, { isAdmin: false }),
    ).toThrow(AppError);
    expect(() => assertLocalSignInAllowed({ ssoOnly: true }, null)).toThrow(
      AppError,
    );
  });
});
