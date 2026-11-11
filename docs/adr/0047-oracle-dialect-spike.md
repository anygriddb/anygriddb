# 0047 — Oracle dialect: thin mode, shipped on the conformance suite

- Status: Accepted
- Date: 2026-11-10
- Relates: [0024](0024-sql-server-authentication-and-oracle.md), [0006](0006-external-sources.md)

## Context

ADR 0024 left Oracle for when a client needs it: review `kysely-oracledb`
or write a `QueryCompiler`, driver `node-oracledb` in thin mode (OSI).

## Decision

1. **License:** `oracledb` is dual-licensed Apache-2.0 OR UPL-1.0; both are
   OSI-approved. AnyGridDB elects **Apache-2.0**. Thin mode only, no Oracle
   Instant Client in the image.
2. **`kysely-oracledb`:** MIT and usable, but reads compile through
   AnyGridDB's own `SqlDialect`, not Kysely. It is not a dependency.
3. **Ship the fifth engine once the conformance suite passes on it**, the
   same suite as the other four (formulas, lookups, rollups, filters,
   writes, side tables, changes made elsewhere, seals, field and row
   rules, copies, charts, imports, trash, links), against Oracle Free 23ai
   in CI. Dialect: `packages/core/src/query/dialect-oracle.ts`.
4. **Each session is set up** the way the dialect reads (UTC, a dot before
   decimals, English names, BINARY comparison, CHAR lengths), whatever the
   database's defaults.
5. **Verified TLS** over TCPS: the thin driver takes trusted authorities
   only in a wallet that holds a key, so AnyGridDB adds a client identity
   made for the process to the pasted authority. It is never sent unless
   the listener asks for one.
6. **Introspection** reads the `ALL_*` views: every schema the account may
   read, with its object and column grants. A side table goes in the
   account's own schema.
7. PostgreSQL stays the control-plane store.

## Consequences

- Engine limits, documented in docs/sources.md next to SQL Server's: no
  empty text (`''` is NULL); `NUMBER` keeps no scale; `DATE` reads as a
  day; regular expressions are refused; locks wait ten seconds.
- A read-only transaction refuses a table altered in the last seconds
  (ORA-01466): such a read runs once more in an ordinary transaction.
- The compiler's text slicing (`LEFT`, `RIGHT`, `MID`), remainders, and
  formula errors go through the dialect: Oracle has neither the functions
  nor an empty text to mark an error without a message.
- CI starts an Oracle Free container (`gvenzl/oracle-free`); that image is
  never part of the official `docker/` install path. Only 23ai is tested:
  19c is the floor the SQL is written for.
