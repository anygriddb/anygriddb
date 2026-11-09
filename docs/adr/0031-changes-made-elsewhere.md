# 0031 — Changes made elsewhere: told by a column or by Change Tracking

- Status: Accepted
- Date: 2026-11-08

## Context

ADR 0006 has other applications' writes to a client's tables detected
periodically, through a modification-date column or SQL Server's Change
Tracking, to feed realtime, webhooks, and automations. Until then a grid
showed an ERP's change only once someone read the table again, and no
webhook or automation knew of it.

The client's database is the reference; AnyGridDB may not add triggers or
columns to it (ADR 0006), and most DBAs will not install a change-capture
stack. What a client's schema often has already: an `updated_at` set by a
default, `ON UPDATE CURRENT_TIMESTAMP`, or a trigger; on SQL Server, a
`rowversion` column or Change Tracking a DBA can switch on.

## Decision

- **An administrator chooses how each exposed table is watched**, in the
  source's page, after AnyGridDB reads again what the account sees:
  - **a column**: a date and time the database sets on every change, or
    SQL Server's `rowversion`; columns named like one are suggested;
  - **SQL Server's Change Tracking**, offered when the DBA enabled it on
    the table and granted `VIEW CHANGE TRACKING`;
  - an interval, 30 seconds by default, 5 at least.

  A table needs a primary key: changes are told by row.

- **A job checks each watched table** on its interval, from a cursor kept
  in AnyGridDB's database (`external_watches`). The first check only
  takes its bearings. A check reads at most 1,000 rows past its cursor;
  more are read a second later.
- **A column** is read in its own order, then the key's, so rows sharing a
  value are paged through. A date and time is written when a transaction
  writes, not when it commits: each check also reads again the two
  minutes behind its cursor, and compares with the rows it already told,
  so a late commit is told too. A `rowversion` check stops short of the
  oldest open transaction's (`min_active_rowversion()`), so nothing lands
  behind it. A row past the highest whole-number key seen is told as
  added; others as changed. **A column tells no delete.**
- **Change Tracking** tells added, changed, and deleted rows exactly,
  since a version. When SQL Server no longer keeps the changes since the
  cursor, open grids read the table again and administrators see why.
- **What a check finds is told like AnyGridDB's own writes**: open grids
  read those rows again with their own rights, and row events reach
  webhooks and automations from the source `external`. Past 200 rows in
  one check, one event per kind carries a count instead.
- **A row AnyGridDB wrote during the interval is left out**: its write sent
  its events already, so an automation that writes a row is not
  triggered again by its own change.
- **One check counts**: the cursor and the events move in one transaction
  of AnyGridDB's database, guarded by a version, so two checks of a table
  (after a restart, two processes) never both tell a change.
- **A source that does not answer** shows its error in the source's page;
  it is asked again less often, and the cursor waits.
- Runs, matches, and deliveries name a client's row by its key as text,
  as comments and notifications already did.

## Consequences

- AnyGridDB reads the client's table every interval: an index on the
  watched column keeps a check cheap.
- With a column, a row deleted elsewhere stays in open grids until they
  read the table again, and no webhook tells it. Change Tracking tells it.
- A change made elsewhere to a row AnyGridDB also wrote in the same
  interval is told once, by AnyGridDB's write.
- A transaction that commits more than two minutes after it wrote a row
  is missed by a date and time column; a `rowversion` or Change Tracking
  never misses one.

## Rejected

- **Triggers or an audit table in the client's database.** AnyGridDB
  changes no client schema (ADR 0006); the audit kit of ADR 0007 stays a
  DBA's choice.
- **PostgreSQL logical replication, MySQL's binlog.** They need rights a
  dedicated reading account does not have, and a slot or a binlog reader
  per source. Later, as an option.
- **Comparing a fingerprint of every row on each check.** It reads the
  whole table every time; it may come for small tables without a column.
