# 0005 — A read engine with one compiler per SQL dialect

- Status: Accepted
- Date: 2026-11-07

## Context

The read engine compiles a page of a table into one SQL query:

- formulas, lookups, rollups, and link labels;
- filters, sorts, groups, search, and aggregates;
- field and row rules (ADR 0016).

Today it emits PostgreSQL text directly. External sources (ADR 0006) need
the same power on MySQL/MariaDB and SQL Server, and the same results.

## Decision

- **An intermediate representation.** Formulas, filters, sorts, groups,
  aggregates, and access rules compile to a typed expression tree that knows
  no dialect.
- **One backend per dialect** renders that tree through Kysely.
  - PostgreSQL first, with today's behavior and tests.
  - Then MySQL/MariaDB and SQL Server.
- **AnyGridDB defines the semantics of formulas**: arithmetic, text, dates,
  blanks, and errors.
  - Each backend reproduces them, with explicit casts where engines differ
    (for example, division is always decimal).
  - A function a backend cannot reproduce exactly is **unavailable** on that
    source, and the formula editor says so. A result is never silently
    different.
- **Filters and sorts on external data follow the source's collation.**
  That is what the client's other applications show, and it keeps their
  indexes usable. Computed values follow AnyGridDB's semantics.
- **Dates without a time zone** in a source are read in a time zone set on
  the source.
- **A conformance suite** runs every function and operator on every engine
  in CI (Testcontainers: PostgreSQL, MySQL, MariaDB, SQL Server), against
  expected results.
- **Large external tables** show a total estimated from the engine's
  statistics, with an exact count on demand. Every query runs under a time
  limit set with the engine's own mechanism.

## Consequences

- This is the largest piece of work in the plan: a mapping of every
  function for every engine, held to a test contract.
- Each source records its dialect, version, and capabilities, detected at
  connection. The formula editor and the filter builder read them.

## Rejected

- **Computing formulas in the application for the visible page only.**
  Then nobody could filter, sort, group, or aggregate on them.
- **Passing native function names through.** Results would differ by
  engine.
