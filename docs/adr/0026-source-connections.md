# 0026 — Source connections: a dedicated account and verified TLS on every engine

- Status: Accepted
- Date: 2026-11-07
- Supersedes: the SQL Server authentication part of
  [0024](0024-sql-server-authentication-and-oracle.md), and the sign-in and
  TLS lines of [0006](0006-external-sources.md)

## Context

ADR 0024 planned three ways to sign in to SQL Server: NTLM, Microsoft Entra
ID, and a Kerberos spike for servers that accept only Windows
authentication. Each one is code, tests, and support cases, for a single
engine.

The product decision is simpler: every client creates a dedicated database
account for AnyGridDB, on every engine. The connection must be secure by
default, without turning security into a configuration project.

## Decision

### One way to sign in

- Every source signs in with **a dedicated database account**, by user name
  and password:
  - a PostgreSQL role;
  - a MySQL or MariaDB user;
  - a SQL Server login (SQL authentication);
  - later, an Oracle user.
- There is no Windows authentication: no NTLM, no Kerberos, no
  `msnodesqlv8`.
- The documentation gives one script per engine that creates the account
  and grants the least it needs:
  - `SELECT` on the exposed tables;
  - `INSERT`, `UPDATE`, and `DELETE` only where writes are enabled;
  - rights on the side schema when enrichment is granted (ADR 0006).

### Secure by default, with no switch to turn it off

- **TLS is required, and the server certificate is verified**: chain and
  host name.
  - A server with an internal certificate authority: the administrator
    pastes that authority's certificate.
  - A server with a self-signed certificate: the administrator pastes that
    certificate. Verification stays on.
  - SQL Server: encryption is mandatory and the certificate is checked
    (`encrypt: true`, `trustServerCertificate: false`). Strict encryption
    (TDS 8.0) is used when the server and the driver support it.
- **No source setting disables TLS or certificate checks.** Only the
  operator variable `ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT` (off by default),
  meant for development and tests, allows it. While it is on,
  administrators see a permanent warning and every start logs one.
- **Administrator accounts are refused.** At connection, AnyGridDB reads the
  account's role and refuses:
  - a PostgreSQL superuser;
  - a MySQL or MariaDB account with any global privilege beyond `USAGE`;
  - a SQL Server `sysadmin` or `db_owner`;
  - an Oracle account with the `DBA` role.
- **What the account may do is read from the database**, not trusted from
  configuration. Introspection reads its privileges per table from the
  engine's privilege views. A table is writable only when the
  administrator enabled writes and the account holds the privilege.
- **Credentials** are encrypted at rest (ADR 0006), write-only through the
  API (never sent back), and never logged. The administrator replaces a
  password; open connections are drained.
- **Every connection names itself** `AnyGridDB` (`application_name`,
  `appName`, or the program name), so the DBA sees its sessions in their
  own monitoring.

## Consequences

- One way to sign in to build, test, and support, the same on every engine.
- A SQL Server that accepts only Windows authentication must turn on SQL
  authentication (mixed mode) for this login. This is the real cost of the
  decision: hardening guides such as the CIS SQL Server benchmark recommend
  Windows authentication only, so a strict DBA may refuse. Kerberos is
  reconsidered when a client is blocked by this, not before.
- An Azure SQL database set to Microsoft Entra-only authentication cannot
  connect. An Entra service principal, which `tedious` supports natively,
  comes only when a client needs it.
- A server without TLS must enable it first. The per-engine guide gives the
  steps. SQL Server's fallback self-signed certificate changes at every
  service restart, so the DBA installs a certificate that lasts.
- The conformance suite (ADR 0005) connects to every engine over verified
  TLS, with test certificates generated for the containers.

## Rejected

- **NTLM.** It needs a Windows domain account, and Microsoft is retiring it.
- **Kerberos**, by a `tedious` extension or by `msnodesqlv8` with
  Microsoft's ODBC driver. A whole authentication stack for one engine.
- **Client certificates, cloud IAM sign-in (RDS, Cloud SQL), secret
  managers (Vault).** Each adds setup for a minority of clients. One can
  come on demand without changing the rules above.
- **A per-source "no TLS" or "accept any certificate" option.** It is the
  setting that ends up in production.
