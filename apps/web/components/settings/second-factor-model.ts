export type MfaMethod = "totp" | "webauthn";

/** How the account page presents TOTP enrollment. */
export function totpAction(
  methods: readonly MfaMethod[],
): "enable" | "replace" {
  return methods.includes("totp") ? "replace" : "enable";
}

/**
 * What the server asks before a change of second factor, so the page asks
 * for it only then: the password when the account has one, or else the
 * current authenticator code. A first authenticator needs none; a passkey
 * needs one as soon as the account has something to prove with.
 */
export function proofNeeded(
  change: "totp" | "passkey",
  account: { methods: readonly MfaMethod[]; hasPassword: boolean },
): "password" | "code" | null {
  const hasTotp = account.methods.includes("totp");
  if (change === "totp" && !hasTotp) return null;
  if (account.hasPassword) return "password";
  return hasTotp ? "code" : null;
}

/** The backup codes as a file to keep: one per line, named and dated. */
export function backupCodesFile(
  codes: readonly string[],
  instance: string,
  issuedOn: string,
): string {
  return [`AnyGridDB — ${instance}`, issuedOn, "", ...codes, ""].join("\n");
}
