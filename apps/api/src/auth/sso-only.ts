/**
 * SSO-only sign-in (ADR 0053): non-administrators open a session only
 * through the identity provider. Administrators keep a password as
 * break-glass.
 */
import { AppError, type InstanceSettings } from "@anygriddb/core";

/** Refuses password or passkey sign-in for a non-admin when SSO-only is on. */
export function assertLocalSignInAllowed(
  settings: Pick<InstanceSettings, "ssoOnly">,
  account: { isAdmin: boolean } | null | undefined,
): void {
  if (!settings.ssoOnly) return;
  if (account?.isAdmin) return;
  throw new AppError("password_sign_in_disabled");
}

/** Refuses creating an account with a password while SSO-only is on. */
export function assertPasswordSignupAllowed(
  settings: Pick<InstanceSettings, "ssoOnly">,
): void {
  if (settings.ssoOnly) throw new AppError("password_sign_in_disabled");
}
