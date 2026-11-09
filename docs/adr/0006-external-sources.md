# 0006 — External sources: live reads and writes on the client's databases

- Status: Accepted
- Date: 2026-11-07

## Decision

### Engines and drivers

| Engine                      | Driver                                        | License    |
| --------------------------- | --------------------------------------------- | ---------- |
| PostgreSQL                  | `pg`                                          | MIT        |
| MySQL 8+, MariaDB           | `mysql2`                                      | MIT        |
| SQL Server 2019+, Azure SQL | `tedious`                                     | MIT        |
| Oracle (later)              | `node-oracledb`, thin mode (no Oracle client) | Apache-2.0 |

`tedious` covers SQL, NTLM, and Entra ID sign-in. Kerberos is to be validated.

### Declaring a source

- Only instance administrators declare a source. Its host must be on an
  allow list: sources usually sit on the internal network, which the
  outgoing-request guard of webhooks refuses on purpose.
- TLS settings and a custom certificate authority are supported.
- Credentials are encrypted like TOTP secrets (AES-256-GCM).
- The documentation gives least-privilege `GRANT`s per engine.
- The administrator picks the tables and views to expose. Nothing is
  exposed by default.
- Each source has a connection limit, a per-query time limit, and an
  optional read replica.

### Schema

- Introspection reads tables, views, primary keys, foreign keys, and types.
- Foreign keys become link fields. Lookups and rollups over them compile to
  joins that run in the client's database.
- Unknown types (geometry, XML, and others) show as read-only text.
- Schema changes made outside AnyGridDB are detected. A field that broke is
  flagged; reads keep working.

### Writes

- A table is read-only until the administrator enables writes. Deletes are
  enabled separately.
- Editing requires a primary key.
- A conflict is shown rather than overwritten.
  - Writes compare the old value: `UPDATE … WHERE key = ? AND column = old`.
  - SQL Server uses its `rowversion` column when one exists.
- Constraint errors from the client's database become clear messages.
- **AnyGridDB never changes the schema of a client table.**

### Enrichment without touching client tables

- Comments, history, attachments, and notifications always live in the
  control plane.
- Fields that AnyGridDB adds (status, notes, tags, and so on) live in **a
  side table in a dedicated schema of the client's database**, when the DBA
  grants one. The join then runs in the same engine, and those fields
  filter, sort, and group like any other.
- Without that grant they live in the control plane. They still filter, but
  cannot sort or group a large table.

### Changes made elsewhere

- Writes made through AnyGridDB reach other users at once.
- Writes made by other applications are detected periodically, through a
  modification-date column or SQL Server Change Tracking enabled by the DBA.
  PostgreSQL logical replication comes later.
- Detection feeds realtime, webhooks, and automations.

### Synced mode (optional, per table)

A table can be a read-only copy in the control plane, refreshed on a
schedule. It suits a DBA who refuses live queries on a production database.
It also gives full power across sources.

### Across sources

A link from one source to another is shown, but cannot filter or sort: no
engine joins across engines.

## Consequences

- AnyGridDB queries production databases. Time limits, connection limits,
  and replicas protect them. When a DBA still refuses, synced mode takes
  over.
- Some features depend on the DBA: a side schema, Change Tracking, a
  dedicated account.
- SQL Server runs in CI only, from Microsoft's Developer image, which is
  free for testing. We never distribute it. That is the interoperability
  exception of the open source policy.

## Rejected

- **Reading client databases through PostgreSQL extensions** (`mysql_fdw`,
  `tds_fdw`). Most managed services refuse them, and they add extensions to
  the internal store.
- **Trino federation.** It runs on the JVM, writes poorly, and adds a
  service.
- **Debezium and Kafka** for change capture. Too heavy for a self-hosted
  product.
