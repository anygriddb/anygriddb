# 0032 — Fields added to client tables live in a side table of the client's database

- Status: Accepted
- Date: 2026-11-08

## Context

People use AnyGridDB to enrich data that stays in their ERP: a follow-up
status, internal notes, a call-back date, a score. ADR 0006 keeps those
fields in a side table, in a schema of the client's database its DBA
gives AnyGridDB, so they filter, sort, and group in the same engine as
the client's own columns. The client's tables are never changed.

## Decision

- **The administrator names the side schema** in the source's form (a
  database on MySQL and MariaDB). The DBA creates it and lets the
  source's account create and alter tables there and read and write
  their rows. Without one, storage fields live in the control plane
  instead ([0046](0046-control-plane-enrichment.md)), with filter via
  key lists and no sort or group on live tables.
- **One side table per exposed table**, `ag_t_<table id>`, made at the
  first field: the client's key columns in their declared types, as its
  primary key, and no foreign key, so the client's table and its
  constraints stay as they are. Each field is a nullable column named
  `ag_<field>`, of a type per engine: text, long text, number
  (`numeric`, or `decimal(38,10)`), checkbox, date, date and time (in
  UTC), single select, email, URL, phone, rating.
- **Reads join it where the rows live.** A table with fields of its own
  reads from the client's table left-joined to its side table on the
  key; the client's columns AnyGridDB reads are listed one by one, so a
  column the account may not read is never asked for. Formulas, lookups
  from other tables, filters, sorts, groups, and aggregates see one
  table. A number AnyGridDB keeps reads canonical (`42.5`), whatever
  scale its column has.
- **Writes go to the side row in the client's transaction**, in the
  three-step trail of ADR 0028: an upsert per engine (`on conflict`,
  `on duplicate key`, or update then insert on SQL Server). A row
  deleted through AnyGridDB loses its side row; a row added through it
  gets its side values once its key is known.
- **AnyGridDB's own fields are edited even where the client's are
  read-only.** A change of side fields alone needs no write switch: it
  locks the side row (made empty if missing, a key lock on SQL Server)
  rather than the client's row, which the account may have no right to
  lock, and is compared with what the person saw like any other.
- **Re-reading the client's table leaves them alone**: neither the
  write switches nor "Refresh fields" mistake a side column for a
  client column gone.
- A field in the trash keeps its side column and values, so it comes
  back with them; a new field never reuses a trashed one's column.

## Consequences

- A DBA grants a schema and table rights to AnyGridDB's account; the
  documentation gives the statements per engine.
- A row deleted by another application keeps an orphan side row until
  its key comes back; it is invisible, since reads start from the
  client's table.
- Side tables follow the client's key: a key changed by the DBA leaves
  them keyed the old way until they are rebuilt.

## Rejected

- **Columns added to the client's table.** AnyGridDB never changes a
  client's schema (ADR 0006).
- **A foreign key from the side table to the client's.** It would hang
  a constraint on the client's table and block its truncation.

Superseded by [0046](0046-control-plane-enrichment.md): refusing every
storage field when no side schema is granted. Control-plane storage is
allowed with the limits that ADR recorded here.
