# 0047 — Oracle dialect: spike before shipping

- Status: Accepted (planning)
- Date: 2026-11-10
- Relates: [0024](0024-sql-server-authentication-and-oracle.md), [0006](0006-external-sources.md)

## Context

ADR 0024 left Oracle for when a client needs it: review `kysely-oracledb`
or write a `QueryCompiler`, driver `node-oracledb` in thin mode (OSI).

## Decision

1. **Spike first**, outside the default install path: license of
   `kysely-oracledb` and `node-oracledb` thin mode on
   https://opensource.org/licenses; conformance of introspect, one page
   read, formulas, lookups, and rollups against Oracle 19c+.
2. **Ship only if** the spike clears the open-source policy and the
   four-engine conformance suite grows to five without weakening
   PostgreSQL as AnyGridDB's own store.
3. Until then the UI does not offer Oracle; the roadmap keeps it open.

## Consequences

- No Oracle dependency in the lockfile until the spike lands.
- Read replicas per source (migration 0046) already cover a common scale
  need without a new dialect.
