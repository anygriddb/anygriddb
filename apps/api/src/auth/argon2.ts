import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id with 64 MiB of memory. `memoryCost` is in KiB. Argon2id is the
 * library's default algorithm: its enum is a `const enum`, which isolated
 * modules cannot import, and the test checks the `$argon2id$` prefix.
 */
export const ARGON2_OPTIONS = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

/**
 * Verified when no account matches, so a missing user costs the same as a wrong password.
 * The plaintext is not stored.
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$jz2qWJwrbBWWYctf1bMr1w$ASSMur5MyD1TjWytKGp7jb692F21j2Kpc4Y4vCrTyuY";

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Verifies a PHC string; the parameters come from the hash itself. */
export function verifyPassword(
  hashed: string,
  password: string,
): Promise<boolean> {
  return verify(hashed, password);
}
