export type MfaMethod = "totp" | "webauthn";

/** How the account page presents TOTP enrollment. */
export function totpAction(
  methods: readonly MfaMethod[],
): "enable" | "replace" {
  return methods.includes("totp") ? "replace" : "enable";
}
