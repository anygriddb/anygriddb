# 0054 — Support role for account helpdesk

- Status: Accepted
- Date: 2026-11-11

## Context

Every administrator action was gated on `is_admin`. Organizations want a
helpdesk that can unlock accounts, hand over reset links, clear factors,
and end sessions without changing security policy, integrations, or
sources.

## Decision

- **`users.is_support`.** An administrator may grant or revoke support.
  Administrators keep every power; support is additive, not a demotion of
  admin.
- **Support may:** list accounts and sessions; unlock; send or hand over a
  password reset; clear factors; unlink SSO; revoke API tokens; end
  sessions; read the audit and sign-in trails (not CSV export).
- **Support may not:** change settings or security policy; configure SMTP,
  OIDC, SAML, or SCIM; manage sources; grant admin or support; erase
  accounts; create accounts; send operator mail; withdraw invitations;
  download the support bundle or access report; cancel jobs.
- **UI:** `/admin` opens for support with only the Accounts, Sessions, and
  Audit tabs.
- **No invitation into a base** (ADR 0042 still holds).

## Rejected

- A third "security admin" role (defer).
- Letting support export CSV trails (reserved for administrators).

## Consequences

- Session payloads carry `isSupport`. MFA enrollment still applies to
  support the way it does to administrators when they use Administration.
