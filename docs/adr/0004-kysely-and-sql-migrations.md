# 0004 — Kysely, `pg`, plain SQL migrations, generated types

- Status: Accepted
- Date: 2026-11-07

## Context

User data lives in tables created at runtime. No ORM can model them. The
read engine (`packages/core/src/query`) already compiles them itself. The
data access library only serves:

- the catalog (about 30 tables);
- migrations;
- from ADR 0006 on, reads and writes on MySQL, MariaDB, and SQL Server.

Today it is Drizzle 0.45 with the `postgres` driver, and it has three
problems:

- **Breaking upgrade ahead.** Drizzle's 1.0 is in release candidates and
  breaks the current API (relational queries v1 removed, casing reworked).
  Staying means migrating anyway.
- **Two sources of truth.** The TypeScript schema and the hand-written SQL
  migrations (triggers, functions, backfills) can drift apart.
- **A weak builder.** It handles CTEs, `LATERAL`, and JSON aggregation
  poorly, hence 28 raw `sql` templates in the API.

## Decision

- **Query builder:** [Kysely](https://kysely.dev) (MIT) for the catalog, and
  as the SQL layer under the multi-dialect engine (ADR 0005).
  - It has built-in dialects for PostgreSQL, MySQL/MariaDB, and SQL Server.
  - It escapes identifiers safely and composes fragments.
- **Driver:** `pg` (node-postgres, MIT), the driver Kysely and
  graphile-worker both use. One driver instead of two.
- **Migrations:** plain SQL files, applied by a small runner.
  - Each migration runs in one transaction, under an advisory lock.
  - Applied files are recorded with a checksum, and a changed file stops
    the start.
  - The SQL is the only source of truth.
- **Types:** generated from the migrated database with `kysely-codegen`,
  checked in, and verified in CI against a fresh database.

## Consequences

- No automatic diff from a TypeScript schema: every migration is written in
  SQL, as the important ones already are.
- About 46 API files that use the Drizzle builder are rewritten.
- The migration journal moves from Drizzle's format to the runner's. The
  runner adopts databases that Drizzle already migrated.

## Rejected

- **Prisma.** The worst fit here. Its model is a static schema, so every
  dynamic table would go through `$queryRaw`. It brings no benefit and is
  the heaviest option.
- **TypeORM, MikroORM.** Their unit of work and identity map fight a schema
  that changes at runtime.
- **Drizzle 1.0.** Defensible if a TypeScript schema mattered more than one
  source of truth. It does not here.
- **Knex.** Untyped. Kysely covers the same dialects with types.
- **SQLAlchemy.** Requires Python (ADR 0001).
