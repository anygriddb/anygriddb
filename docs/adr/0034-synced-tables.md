# 0034 — Synced tables: a copy in AnyGridDB, refreshed and compared

- Status: Accepted
- Date: 2026-11-08

## Context

ADR 0006 reads a client's tables where they live. It keeps one option for
a DBA who refuses live queries on a production database: a table can be
a read-only copy in AnyGridDB's database, refreshed on a schedule. Reads
then touch the client's database once per interval, not once per person
and page.

Statuses, comments, links, webhooks, and automations name a client's row
by the id the read engine gives it. That id is the key in the engine's
own form: `7`, or `[1, 2]` on PostgreSQL and MySQL, or `{"k0":1,"k1":2}`
on SQL Server.

## Decision

- **An administrator chooses, per exposed table, where it is read**: live
  in the client's database (the default), or from a copy refreshed every
  N minutes (15 by default, 1 at least). The choice is audited.
- **The copy lives in AnyGridDB's PostgreSQL**, in the `ag_sync` schema,
  one table per synced table.
  - It holds every stored field in the SQL type AnyGridDB gives that
    field: the client's columns and AnyGridDB's own fields (ADR 0032).
  - Key columns and foreign keys stay whole numbers when the client's
    are, so they sort and join as such.
  - `ag_id` keeps each row's id as the client's engine gives it. A row
    keeps its id, and everything named by it, whichever way the table is
    read.
- **The read engine reads the copy as a PostgreSQL table**: formulas,
  filters, sorts, groups, and aggregates run there. A link reads when
  both of its tables live in the same database. A link between a copy
  and a table read live reads empty, as one query joins one database.
- **A refresh reads the client's table a page at a time**. Each page is a
  short read-only transaction. Foreign keys are read as plain columns,
  without joining their tables. A row moved between two pages is set
  right by the next refresh.
- **A refresh swaps the copies.** It loads a new copy beside the current
  one and compares the two by `ag_id`, on the columns both have. It then
  swaps them by renaming, in one transaction guarded by a version, so a
  read never sees half a copy.
- **Changes reach grids, webhooks, and automations**: added, changed, and
  deleted rows, from the source `external`. Up to 200 changes are told row
  by row; past that, one event per kind carries a count. The first copy
  only takes its bearings. A synced table needs no watch for changes made
  elsewhere (ADR 0031): choosing synced mode removes it.
- **A copy is read-only.** Writes are refused, AnyGridDB's own fields
  included, and they are made in the client's database. Statuses and
  signatures still work (ADR 0033); a seal is compared with the copy.
- **Until the first copy is made, the table is read live.** When the
  table is read live again, the copy is dropped a minute later, once
  reads under way have ended. A copy stops at a million rows.
- **The grid says where it reads**: the date of the copy and its interval,
  under the table's name.

## Consequences

- AnyGridDB's database holds the copied rows; backups grow with them.
- What people see is as old as the last refresh. Reads cost the client's
  database one full read per interval.
- A field added since the last refresh reads empty until the next one.

## Rejected

- **Incremental refresh by the watch column alone, without a periodic
  full reconcile.** It cannot see deletes. Incremental mode upserts
  rows past a watermark and still runs a full copy every N refreshes
  so deletes are found.
- **Writing through to the client's table.** A DBA who refuses live reads
  refuses live writes too.
- **A materialized view or foreign tables in AnyGridDB's database.** They
  need extensions most managed PostgreSQL services refuse (ADR 0006).
