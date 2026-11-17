# 0106 — A migration that may refuse asks before any of them runs

- Status: Accepted
- Date: 2026-11-17
- Amends: 0004
- Relates to: 0048 (releases), 0104 (the first migration that refuses)

## Context

Migrations are SQL files, applied in name order when AnyGridDB starts,
each in a transaction of its own (ADR 0004). A database that holds a
migration the running version does not know stops the start.

ADR 0104 wrote the first migration that refuses a database: 0116 will
not run while a source of an engine no longer read is declared, and
tells the operator to delete it with the version before. Rehearsing the
upgrade from 0.1.0 showed what that costs. 0115 comes first: it is
applied and kept, then 0116 refuses. The version before no longer
starts, since the database now holds a migration it does not know, and
the new one does not either. The instance is closed to the very step it
asks for, and only a backup opens it again.

## Decision

- **A migration that may refuse a database carries a check**, a file
  beside it: `NNNN_name.check.sql`. It refuses by raising, and its
  message says what to do first, with the version before.
- **Every pending migration's check is asked before the first of them
  runs**, each in a transaction that may only read. One refusal stops
  the start (`UpgradeRefused`), and nothing was changed: not a table,
  not the list of applied migrations. The version before starts again
  on the same data.
- **A database that holds nothing is asked nothing**: it has nothing to
  refuse, and none of the tables a check reads.
- **A check reads the database as any released version left it.** It
  runs before the migrations that come ahead of its own, so it names
  only what the oldest release already had, or looks first whether the
  table is there.
- **The migration keeps its own refusal**, for a database that reaches
  it another way. A file changed after it was applied is found before
  anything runs, too.

## Consequences

- An operator whose upgrade is refused starts the version before, does
  the step, and upgrades again (`docs/operations.md`).
- A migration that fails for any other reason still leaves the ones
  before it applied, as before: the new version is started again once
  the cause is gone, or the backup is restored.
- A check is one more file to keep true. A test upgrades the catalog
  each release left, and so asks every check of each of them.

## Rejected

- **Every pending migration in one transaction.** PostgreSQL does not
  let a transaction use an enumerated value it has just added, and many
  migrations add one: whether a release could be applied would depend
  on the version it is applied over.
- **Letting the version before start on a migration it does not know.**
  It would run on a schema it was never tested with.
- **A command of the new version that does the step.** The new version
  would carry what it removed, and work on a database half migrated.
