# 0065 — Table copies in SQL

- Status: Accepted
- Date: 2026-11-13

## Context

A table copied with its rows was read a page at a time through the read
engine and written back through the row service, then its links were
set one row at a time, after every row existed, so a link from the table
to itself could reach the copied rows. The copy kept the map of old ids
to new ones, and every pending link, in memory, and stopped at 100,000
rows. The rows never needed to leave the database: both tables are in the
instance's own.

## Decision

- **Rows are copied in SQL**, `insert … select`, 5,000 at a time by
  sequence number, each chunk a transaction of its own under the audit
  triggers (`source` = `duplicate`), well inside the pool's time limit
  for one statement.
- **A copied row keeps its sequence number and its place.** The number
  pairs it with the row it was copied from, so no map is held anywhere;
  the copy's sequence then starts past the last number it took. Its
  autonumber field shows the numbers its source showed, and its rows come
  in the order people gave them.
- **Links to another table are copied with the row**; a link from the
  table to itself is set once every row exists, a chunk at a time,
  through the sequence numbers. Many-to-many links are copied junction to
  junction the same way, and each copied row's links are written to the
  trail as one change of its field, as `setLinks` would.
- **No ceiling of its own.** A copy holds nothing in memory: the number of
  rows only takes time. Files stay with the table they were sent to, as
  before.

## Consequences

- A copy of a million rows is one job of a few minutes, and a half-made
  copy is removed with it when it fails or is cancelled, as before.
- The rows' new ids are still UUIDv7, given when they are copied.
- Base snapshots, and a base copied through one, still stop at 100,000
  rows: their rows travel in one document (ROADMAP row 83).
