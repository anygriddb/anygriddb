/**
 * PKCE for the authorization code grant (ADR 0094): S256 only.
 */
import { createHash, timingSafeEqual } from "node:crypto";

const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;

/** Whether a code_challenge is well formed for S256. */
export function isCodeChallenge(value: string): boolean {
  return CHALLENGE.test(value);
}

/** Whether a code_verifier is well formed. */
export function isCodeVerifier(value: string): boolean {
  return VERIFIER.test(value);
}

/** S256 challenge of a verifier, as the authorize request stores it. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Whether the verifier matches the stored S256 challenge. Constant-time
 * on equal-length digests.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!isCodeVerifier(verifier) || !isCodeChallenge(challenge)) return false;
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(codeChallengeS256(verifier));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
