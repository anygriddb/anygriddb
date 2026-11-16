# 0097 — What six earlier records say that is no longer so

- Status: Accepted
- Date: 2026-11-16
- Amends: 0004, 0005, 0010, 0014, 0018, 0019

## Context

A record is not rewritten; a later one says what changed. Six records
still said, with no later word, something the tree no longer does.

## Decision

- **0004 and 0005: the read engine writes its SQL itself.** Kysely is
  the catalog's query builder only. The tables people make are read and
  written by SQL that `packages/core` builds per dialect (`SqlDialect`),
  with names checked against a pattern and values bound; `packages/core`
  depends on no query builder. ADR 0047 said so for Oracle; it holds for
  every engine.
- **0010: the object store is an overlay, not a profile.** RustFS runs
  with `compose.s3.yml` beside the default file.
- **0014: the image runs as the numeric user `1000:1000`**, which is the
  base image's `node`, so that a platform can check it is not root.
- **0018: metrics come from `@prometheus-io/client`** (Apache-2.0),
  where the record names `prom-client`.
- **0019: the default file runs four services**: AnyGridDB and
  PostgreSQL, and two that run once before them, one issuing the
  services' certificates (ADR 0030) and one refusing to start an empty
  PostgreSQL 18 over the data of 17.

## Consequences

- The index names this record beside each of the six.
