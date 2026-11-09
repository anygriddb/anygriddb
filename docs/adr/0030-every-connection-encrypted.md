# 0030 — Every connection AnyGridDB opens is encrypted and verified

- Status: Accepted
- Date: 2026-11-08

## Context

ADR 0029 makes the browser's connection HTTPS only. AnyGridDB also opens
connections: to its own PostgreSQL, to an S3 store, to an SMTP relay, to
an identity provider, to clients' databases, and to webhooks. Secure by
design means none of them may go in clear either, by default or by a
setting left as it was.

## Decision

- **The rule**: a connection that leaves the machine is TLS, and the
  server's certificate is verified. The loopback (and a Unix socket) is
  the one exception: the traffic never crosses a network. AnyGridDB
  refuses to start on a setting that breaks the rule, and says which:
  - `DATABASE_URL` beyond the loopback needs verified TLS
    (`sslmode=verify-full`, or a mode node-postgres verifies the same way;
    `sslmode=require` with libpq's semantics is refused);
  - `S3_ENDPOINT` and `SAML_ENTRY_POINT` are `https://`;
  - SMTP uses TLS from the start on port 465 and requires STARTTLS on any
    other, with the certificate verified;
  - clients' databases and webhooks already were (ADR 0026, verified TLS,
    `https://` only); plaintext sources are refused in production
    (ADR 0029).
- **The stack's own services get certificates too.** The instance keeps
  a second authority, **internal**, apart from the one people install:
  only AnyGridDB trusts it, and it is name-constrained to the services'
  names (`db`, `rustfs`). A one-shot `certs` service of the compose file
  (`anygriddb tls services`) issues each service its certificate before
  it starts, its key owned by that service's user alone, and runs as root
  only for that, with no network.
  - PostgreSQL runs with `ssl=on`, TLS 1.2 or later, and a `pg_hba.conf`
    that takes network connections over TLS only (`hostssl`); AnyGridDB
    connects with `sslmode=verify-full` against the internal authority.
  - RustFS serves HTTPS (`RUSTFS_TLS_PATH`); AnyGridDB's S3 client trusts
    the internal authority through `NODE_EXTRA_CA_CERTS`, and RustFS is no
    longer published on the host.
- **Development and the browser tests** run PostgreSQL as the image
  starts it, published on the loopback only (`compose.dev.yml`,
  `compose.e2e.yml`): AnyGridDB on the same machine reaches it there.

## Consequences

- A fresh `docker compose up` encrypts every hop: browser to AnyGridDB,
  AnyGridDB to PostgreSQL and to RustFS.
- A managed PostgreSQL or S3 needs its provider's TLS settings, which they
  all offer; a private authority goes in `sslrootcert` or
  `NODE_EXTRA_CA_CERTS`.
- An existing instance moving to this compose file keeps its data: the
  database volume is unchanged, and only how it is reached changes.

## Rejected

- **Trusting the stack's private network.** It is one setting or one
  misplaced port away from being the host's network.
- **One authority for both.** People install the public one on their
  workstations; the internal one would then vouch for `db` there too.
- **Encryption without verification** (`sslmode=require` in libpq's
  sense). It stops a passive listener, not someone who answers in the
  server's place.
