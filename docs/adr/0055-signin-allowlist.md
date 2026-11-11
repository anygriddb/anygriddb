# 0055 — Sign-in address allowlist

- Status: Accepted
- Date: 2026-11-11

## Context

Operators asked to limit interactive sign-in to known networks without
putting a WAF in front of every install.

## Decision

- **`signInAllowlist` in instance settings:** zero or more IPv4/IPv6
  addresses or CIDR ranges. Empty means any client address may sign in.
- **Gates password sign-up and login, SSO finish, and the same path for
  passkeys after a password challenge.** API tokens, SCIM, and `/metrics`
  are not gated.
- **Client address** is the request IP after `ANYGRIDDB_TRUSTED_PROXIES`
  (already documented).

## Rejected

- Device posture or user-agent rules (out of scope).
- Gating API tokens by IP (operators use network controls for those).

## Consequences

- A misconfigured allowlist can lock out everyone but break-glass from
  an allowed address; administrators should keep a known office CIDR.
