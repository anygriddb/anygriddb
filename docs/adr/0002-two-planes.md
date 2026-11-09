# 0002 — Two planes: AnyGridDB's PostgreSQL, and the client's databases

- Status: Accepted
- Date: 2026-11-07

## Context

Most clients already keep their data in their own databases (MySQL, MariaDB,
SQL Server, PostgreSQL). They want to use AnyGridDB on that data: read it,
enter data, enrich it, visualize it, and reach it through an API or
automations. They will not move it. Other clients want everything inside
AnyGridDB.

## Decision

AnyGridDB has two planes.

- **Control plane.** AnyGridDB's own PostgreSQL (ADR 0003) holds accounts,
  roles, field and row rules, views, dashboards, audit trail, comments,
  notifications, jobs, and native tables. The client does not work in it.
  It is internal, like GitLab's or Keycloak's database.
- **Data plane.** Each table has a storage, `native` or `external`.
  - A native table is a physical table in the control plane's database
    (ADR 0017).
  - An external table is a table or view in a client database, reached
    live through a connector (ADR 0006).
- Everything above storage works the same on both kinds: views, forms, the
  REST API, webhooks, automations, roles, and field and row rules.
- **Native-only is a first-class mode.** An instance without any external
  source is a complete product, and the one with the strongest guarantees
  (ADR 0007).

## Consequences

- The storage of a table becomes an explicit notion in the catalog and the
  engine. Phase 2 of the migration plan introduces it, before any connector
  exists, so connectors add code rather than rewrite it.
- The REST API gives clients an API over their existing databases.
- Some features are weaker on external tables, and the product must say so
  (ADR 0007).

## Rejected

- **Copying client data into AnyGridDB as the main mode.** Clients work on
  live data and write to it. A synced copy stays available per table
  (ADR 0006).
- **Running AnyGridDB's own store on the client's engine.** See ADR 0003.
