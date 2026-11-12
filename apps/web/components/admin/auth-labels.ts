import { useLingui } from "@lingui/react/macro";

/**
 * The words for what the sign-in trail records: its actions and how a
 * person proved who they were. Shared by the trail and an account's page.
 */
export function useAuthLabels() {
  const { t } = useLingui();
  const actions: Record<string, string> = {
    account_created: t`Account created`,
    login_success: t`Signed in`,
    login_failure: t`Sign-in refused`,
    logout: t`Signed out`,
    session_revoked: t`Session ended`,
    factors_cleared: t`Second factors removed`,
    tokens_revoked: t`API tokens revoked`,
    account_locked: t`Account locked`,
    account_unlocked: t`Account unlocked`,
    password_changed: t`Password changed`,
    password_reset_requested: t`Reset link sent`,
    password_reset: t`Password reset`,
    settings_changed: t`Setting changed`,
    account_disabled: t`Account disabled`,
    account_erased: t`Account deleted`,
    account_updated: t`Account changed`,
    sso_unlinked: t`Single sign-on unlinked`,
    operator_mail_sent: t`Notice emailed`,
  };
  const methods: Record<string, string> = {
    password: t`Password`,
    totp: t`Authenticator code`,
    backup: t`Backup code`,
    webauthn: t`Passkey`,
    oidc: "OIDC",
    saml: "SAML",
    signup: t`Sign-up`,
    admin: t`Administrator`,
  };
  return {
    action: (value: string) => actions[value] ?? value,
    method: (value: string | null) => (value ? (methods[value] ?? value) : "—"),
  };
}
