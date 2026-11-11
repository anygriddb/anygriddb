# 0053 — Prove SSO at save, and SSO-only sign-in

- Status: Accepted
- Date: 2026-11-11

## Context

Administrators could save OIDC and SAML settings that never reached a
provider: a mistyped issuer or an unreadable certificate only failed at
the first sign-in. Organizations that require the identity provider for
everyone also had no way to turn off password sign-in while keeping a
break-glass path for administrators.

## Decision

- **Prove at save (and via Test).** Saving OIDC fetches the issuer's
  OpenID discovery document over HTTPS and checks it names authorization
  and token endpoints. Saving SAML parses the IdP PEM with
  `X509Certificate` and refuses an unreadable or expired certificate. A
  Test button runs the same checks without writing. A successful save
  does not replace a real person signing in through the provider.
- **SSO-only.** An instance setting `ssoOnly` (default false) refuses
  password sign-up, password sign-in, and self-service password reset for
  non-administrators. Administrators keep a password so the instance is
  not locked out if the provider fails. Turning `ssoOnly` on requires
  OIDC or SAML to already be ready (`sso_required` otherwise).
- **SCIM unchanged.** Provisioned accounts still have no password and
  sign in through SSO.

## Rejected

- Contacting the provider with the client secret at save (would need a
  redirect and a real user).
- Removing administrator passwords when SSO-only is on (no break-glass).
- Shared rate limits or multi-process HA as part of this change.

## Consequences

- Integration tests stub OpenID discovery; SAML tests use a real PEM.
- The sign-in page learns `ssoOnly` from `auth.instance` so self-reset
  and copy can follow.
