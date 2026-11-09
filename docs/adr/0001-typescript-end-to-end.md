# 0001 — TypeScript end to end

- Status: Superseded by [0021](0021-typescript-end-to-end-measured.md)
- Date: 2026-11-07

## Context

The heart of a spreadsheet database is its domain core: the formula
language, field types, filters, and the parsing of pasted values
(`typecast`). It must run in two places. In the browser, it powers the
formula editor, completion, error messages, and paste validation. On the
server, it compiles formulas and filters to SQL. Today `packages/core`
(about 9,400 lines) is shared by both.

ADR 0006 makes AnyGridDB talk to several SQL dialects. That is where
Python's SQLAlchemy Core is strongest: dialects, reflection, type mapping.

## Decision

Server, client, and shared core stay in TypeScript.

## Consequences

- One implementation of the formula language, field types, and validation
  for client and server.
- Node runs JavaScript on one thread: heavy parsing (a 100,000-row XLSX)
  runs in jobs or worker threads, never in a request.
- Kysely (ADR 0004) covers quoting, parameters, and pagination per dialect.
  We write schema introspection per engine ourselves: primary keys, foreign
  keys, unique constraints, and indexes. That is a few thousand lines.

## Rejected

- **Python with SQLAlchemy.** The best dynamic SQL toolkit there is, but no
  library translates spreadsheet formulas to SQL with the same results on
  every engine. That part is ours in any language. Python would split the
  domain core in two, one copy per runtime, for good.
- **Go.** A single binary and a small memory footprint are real gains for
  self-hosting. The same split of the core applies. ADR 0019 recovers most
  of the gain with one image.
- **Elixir.** Phoenix Presence and Oban fit realtime and jobs very well. The
  contributor pool is too small for an AGPL project that needs one.
- **Rust.** Slower iteration for no product gain at this stage.
- **Bun.** Weaker compatibility with native modules (sharp, argon2) for a
  self-hosted product. Node LTS is the conservative choice.
