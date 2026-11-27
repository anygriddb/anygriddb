# 0139 — A source may connect without TLS when an administrator opts in

- Status: Accepted
- Date: 2026-11-27
- Amends: [0026](0026-source-connections.md), [0030](0030-every-connection-encrypted.md)

## Context

ADR 0026 and 0030 require verified TLS for every client database. An
operator variable `ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT` exists for
development only and is refused in production. Many lab and legacy
databases still offer no TLS: administrators cannot declare them on a
production instance, even when they understand the risk.

Verified TLS stays the right default. The gap is an intentional,
audited exception per source, not a global switch that turns encryption
off for every source at once.

## Decision

- **Default unchanged.** A new source connects over verified TLS. The
  administrator may paste a certificate authority or the server's
  self-signed certificate; verification stays on.
- **Opt-in per source.** A source may set `allow_plaintext`. The
  connection then uses no TLS. The administration dialog asks for an
  explicit confirmation that names the consequence (password and rows
  travel unencrypted). The sources list shows a permanent warning while
  any such source exists, and the catalog audit records the change.
- **Development flag kept.** `ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT` still
  forces plaintext for every source in non-production only, for the lab
  and the suites. Production still refuses that variable at start.
- **Not decided here.** Encryption without certificate verification
  (`trustServerCertificate`, `rejectUnauthorized: false`) stays refused:
  paste the authority instead. The product's own `DATABASE_URL`, S3,
  identity providers, SMTP transport encryption, and outbound HTTPS stay
  as ADR 0030 set them. SMTP may paste a CA (same migration) so a private
  authority verifies without going clear.

## Consequences

- An administrator can declare a legacy database that speaks no TLS, on
  a production instance, after confirming the risk for that source alone.
- Operators who require encryption everywhere leave every source's flag
  off; nothing changes for them.
- ADR 0026's line "no source setting disables TLS" is superseded for this
  opt-in only; every other source rule there still holds.
