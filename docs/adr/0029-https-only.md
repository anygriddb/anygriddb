# 0029 — HTTPS only, with the instance's own authority when no certificate is given

- Status: Accepted
- Date: 2026-11-08

## Context

AnyGridDB served plain HTTP and left TLS to a reverse proxy. An operator
trying it on a network without one sent sessions and passwords in clear,
and browsers dropped the `Secure` session cookie, so sign-in failed. Making
the cookie follow the address fixed the sign-in but kept the clear text.

AnyGridDB holds clients' data and reaches their databases. It must be
secure by design: no setting, default, or missing certificate may leave a
connection in clear.

## Decision

- **The API serves HTTPS only.** There is no plain HTTP listener. On its
  port, the first byte of a connection tells a TLS handshake (0x16) from a
  plain HTTP request; the latter gets a `308` redirect to `https://` on the
  same host and path, and nothing else: no page, no cookie, no data.
- **The certificate**, in this order:
  1. the operator's own, `TLS_CERT_FILE` and `TLS_KEY_FILE` (PEM, the
     chain in the certificate file), checked against each other at start
     and reloaded when the files change, so a renewal needs no restart;
  2. otherwise, one signed by **the instance's own authority**, made at the
     first start in `TLS_DIR` (a volume in the image).
- **The instance's authority** is built to be safe to install:
  - ECDSA P-256 keys, SHA-256 signatures, from `node:crypto`; no new
    dependency writes the certificates (`apps/api/src/tls/certificate.ts`);
  - **name-constrained** to the instance's names (the host of
    `PUBLIC_URL`, `localhost`, `127.0.0.1`, `::1`, and `TLS_NAMES`): a
    workstation that trusts it trusts it for AnyGridDB alone. A
    certificate it signed for another site is refused;
  - its private key, and the server's, are stored encrypted with
    `AUTH_ENCRYPTION_KEY` (AES-256-GCM), so a copy of the volume alone
    gives neither away;
  - the authority lasts ten years and is made anew, with a log line, when
    the instance's names leave its constraints; the server certificate
    lasts 397 days and is renewed a month before it ends, or when the
    names change, without a restart.
- **Installing the authority** is the operator's one step: Administration >
  Health shows its SHA-256 fingerprint and a download link; the start log
  prints the fingerprint; `/tls/authority.crt` serves it to anyone, since
  people install it before they can sign in. Until it is installed,
  browsers warn. TOTP works either way. Passkeys need the authority
  installed **and** a hostname in `PUBLIC_URL` (below).
- **`PUBLIC_URL` must be HTTPS.** Plain HTTP is accepted for one case: the
  development server on the machine's loopback, which forwards to the
  API's HTTPS. The default is `https://localhost:<PORT>`. It is the
  canonical origin: links in emails, `__Host-` cookies, API documents,
  the certificate's primary name, **and** the WebAuthn relying party
  (`rpID` and `expectedOrigin`). People open this address.
- **`TLS_NAMES`** adds other names and addresses to the certificate only
  (IP SANs, aliases). It never sets the WebAuthn RP ID.
- **Passkeys need a DNS hostname.** Browsers refuse a bare IP as RP ID
  (`OriginMissingDomain`). So:
  - `PUBLIC_URL` with a hostname (`localhost`, a domain, or a private
    name such as `grid.lan` / `*.home.arpa` that every workstation
    resolves) → passkeys work once the authority is trusted and people
    open that same origin;
  - `PUBLIC_URL` with an IP alone → HTTPS and TOTP work; passkeys do
    not. Administration > Health and the start log say so. The API
    refuses to start a WebAuthn ceremony for an IP origin
    (`invalid_origin`). Put a resolvable hostname in `PUBLIC_URL` (and
    the IP in `TLS_NAMES` if people still reach it by address) when
    passkeys are required.
- **HSTS** is sent with the operator's certificate. With the instance's
  authority it is not: a browser that has not installed the authority
  could not get past the warning, and would be locked out.
- **Session and MFA cookies** carry the `__Host-` prefix and are always
  `Secure`, `HttpOnly`, and `SameSite=Strict`.
- **The compose file** publishes AnyGridDB on HTTPS and no longer publishes
  PostgreSQL: AnyGridDB reaches it on the stack's own network. An overlay
  (`compose.dev.yml`) publishes it on the loopback for development.
- **Plaintext sources** (`ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT`) are refused in
  production (`NODE_ENV=production`, as in the image).

## Consequences

- Every deployment is encrypted from the first start, with no proxy and no
  certificate to buy. A reverse proxy still fits: it forwards to
  `https://anygriddb:4000`, trusting the instance's authority or not
  checking it on a private network, and may add HSTS itself.
- A LAN install that people open by IP stays valid for HTTPS and TOTP;
  passkeys wait on a hostname that matches `PUBLIC_URL`. Health and the
  second-factor UI do not offer a passkey ceremony that the browser would
  refuse.
- Tests run the server over HTTPS; the browser tests accept its authority
  without installing it.
- Container health checks call `anygriddb health`, which asks the API on
  the loopback over HTTPS.

## Rejected

- **A self-signed server certificate without an authority.** Each renewal
  would change what people trust, and browsers give a self-signed leaf no
  way to be trusted once and for all.
- **An unconstrained authority, as development tools make.** Installed on a
  workstation, its key would let whoever holds it impersonate any site.
- **Plain HTTP behind a trusted proxy flag.** It leaves a clear listener on
  the network for anyone who reaches the port directly.
- **A separate port for the redirect.** People type the address they were
  given; the same port must answer it.
- **A WebAuthn RP ID decoupled from `PUBLIC_URL`.** The browser origin and
  the RP ID must match what people open; a separate override would lie.
- **Refusing an IP `PUBLIC_URL` at start.** That would break LAN installs
  that only need TOTP. The incompatibility is for passkeys alone, and is
  made visible.
