import { describe, expect, it } from "vitest";
import { mayRead } from "./session";

describe("mayRead", () => {
  it("is so once signed in, where no second factor is asked or one is there", () => {
    expect(mayRead({ mfaRequired: false, mfaEnrolled: false })).toBe(true);
    expect(mayRead({ mfaRequired: false, mfaEnrolled: true })).toBe(true);
    expect(mayRead({ mfaRequired: true, mfaEnrolled: true })).toBe(true);
  });

  it("is not while the policy asks for a factor the account has not, nor signed out", () => {
    expect(mayRead({ mfaRequired: true, mfaEnrolled: false })).toBe(false);
    expect(mayRead(null)).toBe(false);
    expect(mayRead(undefined)).toBe(false);
  });
});
