# 0015 — Authentication libraries

- Status: Accepted
- Date: 2026-11-07

## Decision

| Piece            | Decision                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions         | Kept, homemade. They are small, tested, and tied to product rules: a second factor before administration, disabled accounts, a 15-minute sliding window, a 12-hour cap                                                                         |
| TOTP             | Kept, homemade (RFC 6238 with `node:crypto`)                                                                                                                                                                                                   |
| Passkeys         | `@simplewebauthn/server` and `@simplewebauthn/browser`, kept                                                                                                                                                                                   |
| SAML             | `@node-saml/node-saml`, kept and kept up to date                                                                                                                                                                                               |
| OIDC             | **`openid-client`** (MIT, OpenID Certified) replaces the homemade discovery and `jose` checks in `apps/api/src/auth/enterprise.ts`. It handles PKCE, nonce, issuer checks, and JWKS rotation. The protocol has too many traps to write by hand |
| Password hashing | **`@node-rs/argon2`** (prebuilt binaries) replaces `argon2`. Argon2id at 64 MiB is unchanged, and stored PHC strings verify as they are. Images no longer need python3, make, or g++                                                           |
| Secrets at rest  | AES-256-GCM with `node:crypto`, kept. Key rotation through a key id prefix comes later                                                                                                                                                         |

## Rejected

- **Better Auth.** It owns the user and session schema and imposes its own
  model. The product's compliance rules would become workarounds.
- **An external identity provider as a requirement** (Keycloak, Authentik,
  Zitadel). One more service. OIDC and SAML already let an operator plug in
  theirs.
