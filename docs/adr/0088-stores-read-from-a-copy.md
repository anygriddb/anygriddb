# 0088 — Stores that speak no SQL are read from a copy

- Status: Accepted
- Date: 2026-11-15
- Relates to: 0006 (client databases), 0026 (declaring a source), 0027
  (one read engine, limits said), 0034 (synced tables, whose copy this
  reuses)

## Context

AnyGridDB reads a client's tables where they live, through one read
engine that compiles every filter, sort, search, group, formula and link
to the SQL of the client's engine (ADRs 0006, 0027). Some stores that
hold records speak no SQL: document databases first among them. People
want the same grid on them.

A second read engine for each such store would have to answer
everything the first one does, in a query language that often cannot:
most of them join nothing, sort only by an index, and count by reading.
The grid would lose a filter here and a formula there, store by store,
and every later feature would be built several times.

A synced table already reads a client's table from a copy in
AnyGridDB's own PostgreSQL (ADR 0034): the one read engine reads the
copy, and a refresh compares the new copy with the old and tells what
changed.

## Decision

- **A store that speaks no SQL is read from a copy, and only from a
  copy.** Exposing one of its tables makes its copy at once, empty, and
  queues the first refresh; every read people make goes to the copy,
  through the one read engine. Nothing on such a table is less than on
  a table of AnyGridDB's: filters, sorts, search, groups, formulas,
  charts, views, exports.
- **A connector does three things, and nothing else.** It signs in and
  refuses an account that administers the store; it lists what the
  account may read, each field with the type its values have; it reads
  a table's rows from first to last, a page at a time. It builds no
  query from what a person asks.
- **Nothing is ever written to the store.** No row, no field of
  AnyGridDB's, no table of its own: such a source has no side schema.
  It has no read replica either: the copy already spares the store the
  reads people make.
- **Whole, every time.** A refresh reads the table again from first row
  to last, every hour unless an administrator says otherwise, a million
  rows at most; beyond, the refresh fails and says so. It is compared
  with the copy before, so grids, webhooks and automations are told
  what was added, changed and deleted, as for any synced table.
- **A store without a schema tells its fields by its rows.** A field's
  type is the type of its values in the rows sampled when the table is
  listed. A value met later that is not of that type reads empty, and
  the refresh counts such values: the source's page says how many, and
  reading the table's fields again follows the store. A field that
  holds a document or a list is kept whole, as JSON.
- **The same rules as any source.** Declared by an administrator, on a
  host the operator allows, over verified TLS, with the password sealed
  under the instance's key. The connection goes to the host the source
  names and to no other: a list of members a server tells of is not
  followed, so the operator's list of hosts holds.
- **The first store: the MongoDB wire protocol.** A collection is a
  table, a document a row named by its `_id`, a top-level field a
  column. It is tested against FerretDB, which speaks that protocol
  under an OSI license; MongoDB's own server speaks it too, and is not
  part of the tests, its license not being one AnyGridDB's tools take.
- **OpenSearch.** An index is a table, a document a row named by its
  `_id`, a top-level field of the mapping a column. The mapping says
  each field's type. It is tested against OpenSearch 2. A cluster that
  does not say it is OpenSearch is refused.

## Rejected

- **A second read path beside the read engine**, which a draft built:
  it refused every filter, search and group, paged by offset, and its
  writes skipped the comparison every write to a client's table makes.
- **Translating reads to each store's query language.** What a store
  cannot answer would be refused or done in memory, a different list
  for each: the limits of five engines are already said one by one
  (ADR 0027), and those engines all speak SQL.
- **Writes.** They would need, store by store, the lock and the
  comparison a client's SQL table gets (ADR 0028). A copy that takes no
  write is plain to explain; a store that takes some is not.
- **An incremental refresh.** No such store gives a column that moves
  on every change; a whole copy is right every time, deletes included.

## Consequences

- People see a store's data as of its last copy, up to an hour late by
  default, and the source's page says when that was.
- A table over a million rows is not read. That is a limit of this
  design, said in the guide.
- A new store is a connector and its tests against a real server, an
  engine's name, and a paragraph of the guide: no change to the read
  engine, the grid, or the API.
