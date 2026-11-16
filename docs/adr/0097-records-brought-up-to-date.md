# 0097 — What seven earlier records say that is no longer so

- Status: Accepted
- Date: 2026-11-16
- Amends: 0004, 0005, 0010, 0014, 0017, 0018, 0019

## Context

A record is not rewritten; a later one says what changed. Seven records
still said, with no later word, something the tree does not do.

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
- **0017: a base has no schema of its own yet.** The tables AnyGridDB
  stores live in `public`, each named `t_<id>`. The move to one schema a
  base waits for the feature that needs it, read-only SQL access to one
  base: until then it would touch every SQL builder for no visible gain,
  and nothing done meanwhile makes it harder, since a table moves with
  `ALTER TABLE … SET SCHEMA`. A base's snapshot and its purge go through
  the catalog, not through the schema.
- **0018: metrics come from `@prometheus-io/client`** (Apache-2.0),
  where the record names `prom-client`.
- **0019: the default file runs four services**: AnyGridDB and
  PostgreSQL, and two that run once before them, one issuing the
  services' certificates (ADR 0030) and one refusing to start an empty
  PostgreSQL 18 over the data of 17.

## Consequences

- The index names this record beside each of the seven.
