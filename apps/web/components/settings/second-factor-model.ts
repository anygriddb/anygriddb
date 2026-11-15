export type MfaMethod = "totp" | "webauthn" | "email";

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
 * needs one as soon as the account has something to prove with. A code by
 * email needs none as the account's first factor, and one beside another
 * factor, where it is one more way in; turning it off asks as a passkey
 * does.
 */
export function proofNeeded(
  change: "totp" | "passkey" | "email" | "email_off",
  account: { methods: readonly MfaMethod[]; hasPassword: boolean },
): "password" | "code" | null {
  const hasTotp = account.methods.includes("totp");
  if (change === "totp" && !hasTotp) return null;
  if (change === "email" && account.methods.length === 0) return null;
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
