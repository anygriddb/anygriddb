# 0017 — One PostgreSQL schema per base; links across bases deferred

- Status: Accepted
- Date: 2026-11-07

## Decision

- **Each base's native tables live in their own PostgreSQL schema**
  (`base_<id>`). The catalog stays in `public`.
  - Existing tables move with `ALTER TABLE … SET SCHEMA`, which only touches
    metadata.
- **Gains:**
  - isolation from the catalog;
  - a base snapshot through `pg_dump -n`;
  - a purge through `DROP SCHEMA … CASCADE`;
  - later, read-only SQL access granted with `GRANT USAGE` on one schema.
- **Links across bases are not built now.** Foreign keys work across
  schemas of one database, so this layout does not prevent them.
- When a client needs shared reference data across bases (customers, staff,
  sites, products), we will choose between two forms:
  - **A real link.** It needs a workspace level above bases, links only
    inside one workspace, and read checks on the other base everywhere:
    reads, paste and typecast, and field creation. One check missed is a
    leak from one base into another.
  - **A synced table**, a read-only copy in the other base. It is simpler
    for rights and snapshots, but the copy is not live.

## Rejected

- **All user tables in `public`**, as today.
