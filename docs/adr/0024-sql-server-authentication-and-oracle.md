# 0024 — SQL Server authentication and the Oracle dialect: gaps we close ourselves

- Status: Accepted; its SQL Server part is superseded by
  [0026](0026-source-connections.md)
- Date: 2026-11-07

## Context

ADR 0006 picked `tedious` for SQL Server and left Kerberos "to be
validated". It is now checked:

- `tedious` supports SQL logins, NTLM, and Microsoft Entra ID. It does not
  support Kerberos, and its maintainers have no plan to add it
  ([tediousjs/tedious#1424](https://github.com/tediousjs/tedious/discussions/1424)).
- Microsoft is retiring NTLM
  ([tediousjs/tedious#1614](https://github.com/tediousjs/tedious/discussions/1614)).
  On-premises SQL Servers set to Windows authentication only will then
  require Kerberos.

ADR 0006 also lists Oracle for later. Kysely has no official Oracle dialect
([kysely-org/kysely#777](https://github.com/kysely-org/kysely/issues/777)).
A community dialect exists, `kysely-oracledb`.

## Decision

### SQL Server

- **Version 1** supports SQL logins, NTLMv2, and Entra ID, and the
  documentation says so. The recommended setup is a dedicated SQL login
  with the least-privilege `GRANT`s of ADR 0006.
- **Kerberos, in phase 5:** a spike adds an SSPI login to `tedious`, using
  the GSSAPI binding `kerberos` (Apache-2.0, maintained by MongoDB for its
  own driver) on top of the system's MIT Kerberos. The work goes upstream
  first.
- **Fallback if the spike fails:** an optional `msnodesqlv8` connector on
  Microsoft's ODBC driver. The operator installs that driver; the image
  never ships it, because its license is not OSI (open source policy).

### Oracle

- When Oracle comes, `kysely-oracledb` is reviewed first: code, license,
  maintenance, and the conformance suite (ADR 0005).
- If it falls short, we write our own Kysely `QueryCompiler` for Oracle:
  quoting, `:n` binds, `FETCH FIRST`, no boolean type, and empty strings
  that are `NULL`.
- The driver stays `node-oracledb` in thin mode (ADR 0006).

## Consequences

- A client whose SQL Server accepts only Windows authentication waits for
  phase 5, or connects through synced mode set up by its DBA.
- Each source records its authentication method among its capabilities.

## Rejected

- **Switching the server language for its drivers** (JVM, Go, .NET). See
  ADR 0021.
- **Shipping Microsoft's ODBC driver in the image.** Its license is not OSI.
