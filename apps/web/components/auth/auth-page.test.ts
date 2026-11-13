import { describe, expect, it } from "vitest";
import {
  invitationToken,
  offersSignup,
  onSignIn,
  safeNext,
  signupNeedsMail,
  signupView,
} from "./auth-page";

describe("safeNext", () => {
  it("keeps an in-app path", () => {
    expect(safeNext("/b/abc")).toBe("/b/abc");
    expect(safeNext("/settings?tab=1")).toBe("/settings?tab=1");
  });

  it("rejects open redirects and nested auth pages", () => {
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("/login")).toBe("/");
    expect(safeNext("/login?next=%2F")).toBe("/");
    expect(safeNext("/login#top")).toBe("/");
    expect(safeNext("/signup")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
});

describe("invitationToken", () => {
  it("reads the invitation a sign-up comes from", () => {
    const token = "a".repeat(43);
    expect(invitationToken(`/invite/${token}`)).toBe(token);
  });

  it("finds none in any other path", () => {
    expect(invitationToken("/")).toBeUndefined();
    expect(invitationToken("/invite/short")).toBeUndefined();
    expect(invitationToken(`/invite/${"a".repeat(43)}/more`)).toBeUndefined();
    expect(invitationToken(`/b/${"a".repeat(43)}`)).toBeUndefined();
  });
});

describe("signupNeedsMail", () => {
  const token = "a".repeat(43);

  it("tells, before anything is typed, that a sign-up of one's own cannot succeed", () => {
    expect(signupNeedsMail(true, "/")).toBe(true);
    expect(signupNeedsMail(true, "/b/abc")).toBe(true);
  });

  it("lets an invitation's link through, and any sign-up where email works", () => {
    expect(signupNeedsMail(true, `/invite/${token}`)).toBe(false);
    expect(signupNeedsMail(false, "/")).toBe(false);
    expect(signupNeedsMail(undefined, "/")).toBe(false);
  });
});

describe("onSignIn", () => {
  it("knows the sign-in pages, where a redirect must not start again", () => {
    expect(onSignIn("/login")).toBe(true);
    expect(onSignIn("/signup")).toBe(true);
  });

  it("leaves every other page, the deep ones included, to be returned to", () => {
    expect(onSignIn("/admin/security")).toBe(false);
    expect(onSignIn("/signup/abc")).toBe(false);
    expect(onSignIn("/")).toBe(false);
  });
});

describe("signupView", () => {
  const read = { ssoOnly: false, needsMail: false };

  it("waits for the policy, then offers the form where it can succeed", () => {
    expect(signupView({ ...read, policy: undefined })).toBe("wait");
    expect(signupView({ ...read, policy: "open" })).toBe("form");
    expect(signupView({ ...read, policy: "invite" })).toBe("form");
  });

  it("shows a notice and no form where nothing typed could succeed", () => {
    expect(signupView({ ...read, policy: "closed" })).toBe("closed");
    expect(signupView({ ...read, policy: "open", ssoOnly: true })).toBe(
      "sso-only",
    );
    expect(signupView({ ...read, policy: "open", needsMail: true })).toBe(
      "needs-mail",
    );
  });
});

describe("offersSignup", () => {
  it("offers an account once the policy is read and lets one in", () => {
    expect(offersSignup({ policy: "open", ssoOnly: false })).toBe(true);
    expect(offersSignup({ policy: "invite", ssoOnly: false })).toBe(true);
  });

  it("offers nothing before the policy is read, or where none can be made", () => {
    expect(offersSignup({ policy: undefined, ssoOnly: false })).toBe(false);
    expect(offersSignup({ policy: "closed", ssoOnly: false })).toBe(false);
    expect(offersSignup({ policy: "open", ssoOnly: true })).toBe(false);
  });
});
