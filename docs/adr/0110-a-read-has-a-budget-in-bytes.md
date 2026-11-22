# 0110 — A read has a budget in bytes

- Status: Accepted
- Date: 2026-11-22

## Context

A read was bounded in rows (1 to 1,000) and in nothing else. A cell holds up
to 20,000 characters and a formula can build far more, so a page could weigh
hundreds of megabytes. It was brought whole into memory, then written out as
one string. A request can name up to 100 calls. One such request, with no
account, through a public link, ended the process for everyone, and so did
one page read over MCP, whose answer carries the data twice.

## Decision

- **A request has 64 MiB of rows.** Its calls count together. Past that it is
  refused with `page_too_large`, which says to ask for fewer rows or fields.
- **The process has a quarter of its heap.** All requests together hold no
  more. Past that a read is refused with `reads_busy` (503), and can be tried
  again. What a request took is given back when its response has left.
- **The rows past the limit are never brought in.** On AnyGridDB's own
  database a page is read through a cursor, 16 rows at a time, each lot counted
  before the next. A client's database answers whole through its driver: its
  rows are counted once read, before anything is built from them.
- **A request names at most 10 calls to public links.** No page sends more.

The app's procedures, the REST API, MCP and public links all read under it.
Exports, snapshots and automations run in the background with limits of their
own, and do not.

## Rejected

- **A short page.** Returning the rows that fit would look like the end of the
  table to a reader that stops at the first short page, as the grid does. A
  refusal is visible and says what to do.
- **Measuring in SQL.** Adding up each row's size in the query costs every read
  a second serialization, and differs on each engine.
- **A smaller batch alone.** One page of a wide table is enough to end the
  process.

## Consequences

- A page of 1,000 rows of very long cells must now be asked for in smaller
  pages. The grid's pages of 100 rows are far below the limit.
- A cell a formula computes is not bounded by this: a lot of 16 rows is counted
  once it has arrived.
