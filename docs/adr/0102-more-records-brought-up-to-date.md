# 0102 — Seven more records that no longer say what is so

- Status: Accepted
- Date: 2026-11-17
- Amends: 0006, 0009, 0012, 0019, 0024, 0026, 0088

## Context

ADR 0097 brought seven records up to date. Every record has since been
read again, against the tree and against the others. Seven more say
something that is no longer so, or that another record contradicts, with
no later word.

## Decision

- **0006 and 0026: six engines, and one of them is a file.** Oracle is no
  longer to come (ADR 0047). A SQLite database is a source too: a file on
  the machine that runs AnyGridDB, opened with Node's own `node:sqlite`.
  It has no account to refuse and no connection to encrypt, so ADR 0026's
  two rules do not apply to it. What stands in their place is the
  operator's: `ANYGRIDDB_SOURCES_ALLOWED_PATHS` lists the folders such a
  file may be in, links are followed before the check, and no folder is
  allowed until the variable names one.
- **0009: no Redis in the stack, a client for its protocol in the image.**
  AnyGridDB still needs PostgreSQL and nothing else. Since ADR 0088 the
  image carries `ioredis`, to read a store a client already runs.
- **0012: the compiler does not memoize the grid's cells.** The cell's
  view and the grid are among the components the React Compiler leaves as
  they are written (`apps/web/lib/react-compiler-left-out.txt`, which a
  test keeps from growing). The selection is kept outside React state, as
  decided.
- **0019: no call to an outside service until someone turns one on.** The
  record names one exception, a link to a map. An administrator may now
  turn on the release check (ADR 0048), a tile server (ADR 0068), a
  collector (ADR 0056), notification channels (ADR 0092), and scripts
  that call an address (ADR 0101); a person may import a base from
  Airtable (ADR 0037) or point a webhook somewhere. An instance left as
  it was installed still calls nothing.
- **0024: superseded whole.** Its SQL Server part by ADR 0026, its Oracle
  part by ADR 0047: reads compile through AnyGridDB's own dialect, and
  `kysely-oracledb` is not a dependency.
- **0088: Redis's own server is under an OSI license too.** The record
  says it is not; since version 8 it is also offered under the AGPL
  (ADR 0009). The tests still run against Valkey.

## Consequences

- The index names this record beside each of the seven. It also names
  four records beside the ones they replace in part: 0025 (0020), 0041
  (0013), 0043 (0042, which said no account is ever locked), and 0070
  (0038).
- The index has two statuses, Accepted and Superseded. "Implemented" said
  nothing more than Accepted (0016, 0018). ADR 0017 reads "not built",
  which is what ADR 0097 found.
- SQLite is not among the engines the conformance suite runs (ADR 0005).
  The ROADMAP's known limits say so, and row 109 puts it there.
