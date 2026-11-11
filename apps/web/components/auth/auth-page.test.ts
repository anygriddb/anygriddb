import { describe, expect, it } from "vitest";
import { invitationToken, safeNext } from "./auth-page";

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
