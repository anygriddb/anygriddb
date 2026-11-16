import { describe, expect, it } from "vitest";
import {
  codeChallengeS256,
  isCodeChallenge,
  isCodeVerifier,
  verifyPkce,
} from "./pkce.js";

describe("PKCE S256", () => {
  it("accepts a matching verifier and refuses a wrong one", () => {
    const verifier = "a".repeat(43);
    const challenge = codeChallengeS256(verifier);
    expect(isCodeChallenge(challenge)).toBe(true);
    expect(isCodeVerifier(verifier)).toBe(true);
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce("b".repeat(43), challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
  });
});
