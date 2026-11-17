# 0107 — A SQLite file is no longer a source

- Status: Accepted
- Date: 2026-11-17
- Amends: 0102 (what it noted on 0006 and 0026); closes ROADMAP row 109
- Relates to: 0005 (one read engine, a conformance suite), 0023 (exact
  numbers), 0027 (an engine's limits are shown), 0104 (the stores taken
  out before it), 0106 (a migration asks before any runs)

## Context

A sixth engine arrived beside the five the read engine was written for:
a SQLite file on the machine that runs AnyGridDB, opened in the
application's process, its dialect made of MySQL's with a few functions
respelled. It came without a record and outside the conformance suite
that holds the five others to one result (ADR 0005). ADR 0102 noted it,
and row 109 was to put it on the suite, or see that it could not be.

Run beside the reference, on the suite's own rows:

- **A page that returns a text is not read.** A table with a text
  column fails to open, as does a formula that gives a text; the file
  answers that its JSON is malformed. A table of numbers alone reads.
- **None of the suite's formulas agrees with the reference**: those the
  dialect does not refuse fail when read, and a filter, a sort, and a
  search fail with the page.
- **A table that points to another by a foreign key is refused whole**,
  with every field added to it.
- A number that is read comes back as a floating point value, where
  every other engine gives the decimal it holds (ADR 0023).

So the engine never showed a grid of an ordinary table. And what it
would take is not a dialect to finish. SQLite has no decimal type, no
time zones, no regular expressions, and no hash functions: where the
five agree, it could only refuse or carry a limit on nearly every
number and every date. A file on the server is also not a client's
database as ADR 0026 means one: no account to refuse, no connection to
verify, a path on the host to guard instead, and a lock on the whole
file when another application writes to it.

## Decision

- **A SQLite file is no longer a source.** Its dialect, its connector,
  the guard on its path, and the two settings that went with it
  (`ANYGRIDDB_SOURCES_ALLOWED_PATHS`,
  `ANYGRIDDB_SOURCES_SQLITE_ALLOW_MEMORY`) are gone.
- **Five engines are read where they live**: PostgreSQL, MySQL,
  MariaDB, SQL Server, and Oracle, each on the conformance suite. An
  engine joins them on that suite, with a record of its own, or not at
  all.
- **An instance that declared such a source is not upgraded over it.**
  The migration that takes the engine out of the catalog refuses while
  one is declared, before anything changes (ADR 0106), and says what to
  delete with the version before. As for the stores of ADR 0104,
  nothing deletes a base's tables for its owners.

## Consequences

- An operator who declared a SQLite source deletes its tables from
  their bases and from each base's trash, then the source, before
  upgrading. No grid is lost: none of those tables opened.
- The application no longer opens a file an administrator names by its
  path.
- What the suite says of the five engines is again what the product
  says of every engine it reads.

## Rejected

- **Writing the dialect and putting it on the suite.** Most of the
  suite would end as refusals and limits, for an engine whose file must
  first be put on the server by its operator.
- **Keeping it with a warning for one more version.** A deprecation
  keeps what works; this did not read a table.
- **Copying the file's tables into a base instead.** A file brought
  once is an import, a feature of its own, decided when someone asks
  for it.
