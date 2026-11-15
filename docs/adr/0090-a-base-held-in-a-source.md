# 0090 — A base held in a SQL source

- Status: Accepted
- Date: 2026-11-15
- Relates to: 0006 (client databases), 0026 (declaring a source), 0088
  (a store that speaks no SQL is read from a copy)

## Context

A table AnyGridDB creates lives in its own database. A client's table
is read where it lives, and AnyGridDB does not change that table's
shape. Some people want the tables they create to live in a database
they already run, under a schema that belongs to the base, while the
grid, the members and the history stay here.

## Decision

- **An administrator can put a new base in a SQL source.** The engines
  are PostgreSQL, MySQL, MariaDB and SQL Server. Oracle is not offered.
  A store read from a copy cannot hold a base: it has no tables for
  AnyGridDB to create.
- **The schema is the product's.** Its name is `ag` and part of the
  base's id, checked before any statement. The tables in it are named
  by the product, not by the person's label. A table that already
  existed at the client is never one of these, and is never altered
  by this path.
- **What is created there is the table and its stored columns.** A
  row's values are written there, through the same comparison a
  client's table gets. Members, views, dashboards, files, comments
  and history stay in AnyGridDB. A formula, a button and a row id
  stay fields of the catalog.
- **A starting point is not applied.** Its sample rows and its links
  are written as AnyGridDB's own tables. The base starts empty.
  Duplicating one of its tables is not offered. Duplicating a column
  copies the values through the same write as the grid.
- **Deleting the base leaves the schema.** Deleting it for good can
  also drop the schema, and only then, when an administrator types
  the schema's name. A wrong name deletes nothing.

## Rejected

- **Putting the base in a store that speaks no SQL.** That store is
  read from a copy, and nothing is written to it (ADR 0088).
- **Applying a template into the schema.** The template's links would
  be columns of the client's database, which this path does not add.

## Consequences

- The account declared on the source must be allowed to create that
  schema and the tables in it. If it cannot, neither the base nor the
  schema remains.
- The schema outlives the base until an administrator types its name.
