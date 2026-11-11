# 0050 — Operator integrations in the UI

- Status: Accepted
- Date: 2026-11-11

## Context

SMTP, OIDC, and SAML were only environment variables. An operator who
built an image with an empty compose file had to recreate the API
container to turn email or single sign-on on. Administrators already
change security policy and SCIM tokens in the UI; they asked for the
same for every integration that does not need a process restart and
does not widen a network or observability boundary.

## Decision

- **Env is optional bootstrap.** An instance may start with no SMTP,
  OIDC, or SAML variables. The administrator configures them under
  Administration > Integrations after the first account exists.
- **What is saved in the UI wins.** A saved row is the source of truth;
  the database refuses an incomplete one. With no row, the environment
  applies, so existing Docker installs keep working.
- **A save is checked first.** SMTP is saved once the relay answers with
  these settings (TLS, account); an OIDC issuer and a SAML entry point
  must be `https://`, as the environment's already are (ADR 0030).
- **Secrets stay out of `instance_settings`.** Passwords and client
  secrets live in dedicated singleton tables with `*_ciphertext` /
  `*_nonce` sealed by `AUTH_ENCRYPTION_KEY`, never returned by the API.
  Policy knobs stay in `instance_settings` (ADR 0043).
- **Redirect and callback URLs** for OIDC and SAML are derived from
  `PUBLIC_URL` when the config comes from the database. `PUBLIC_URL`
  itself stays an environment variable (cookies, WebAuthn, SCIM URL).
- **Non-secret ceilings** that do not need a restart (for example the
  largest attachment size) may live in `instance_settings`, with the
  environment as bootstrap when the key is absent.

### Stays environment-only

Boot, data plane, network allow-lists, and observability:

- `DATABASE_URL`, `AUTH_ENCRYPTION_KEY`, `PORT`, `PUBLIC_URL`, `TLS_*`
- File storage / `S3_*` (chosen at process start; CLI without a database)
- `ANYGRIDDB_TRUSTED_PROXIES`, `ANYGRIDDB_SOURCES_ALLOWED_HOSTS`,
  `ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT`
- `METRICS_TOKEN`, `OTEL_*`, `WORKER_CONCURRENCY`, `JOB_CONCURRENCY`
- `ADMIN_EMAILS` remains a boot-time promotion list; administrators
  already grant or revoke admin in the UI

## Rejected

- Putting SMTP passwords or OIDC client secrets in `instance_settings`
  JSON (they would ride `admin.settings` into the SPA).
- Making the environment win when both are set (GitOps lock): operators
  who want that keep only env and leave the UI empty.
- Editing storage driver, trusted proxies, or source host allow-lists
  from the UI (restart or network boundary).

## Consequences

- `resolveSmtp` / `resolveOidc` / `resolveSaml` sit between callers and
  the mail or SSO libraries; workers resolve once per task deps build.
- Saving an integration invalidates a short cache (same idea as the
  security gate) so every API process sees the change within seconds.
  The OIDC provider's discovered configuration is kept for the issuer,
  client, and secret it was discovered with: a process that sees another
  discovers again.
- Support bundles still report only booleans (smtp / oidc / saml), never
  hosts with credentials.
