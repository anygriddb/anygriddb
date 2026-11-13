import { describe, expect, it } from "vitest";
import { stepUpFields } from "./step-up-model";

describe("stepUpFields", () => {
  it("asks the password when the account has one", () => {
    expect(stepUpFields("password")).toEqual({
      password: true,
      code: false,
      signIn: false,
    });
  });

  it("asks only the authenticator for an SSO account with TOTP", () => {
    expect(stepUpFields("code")).toEqual({
      password: false,
      code: true,
      signIn: false,
    });
  });

  it("asks a fresh sign-in for a passkey-only account", () => {
    expect(stepUpFields("sign_in")).toEqual({
      password: false,
      code: false,
      signIn: true,
    });
  });
});
