# 0028 — Writes to client tables: compared under lock, recorded in three steps

- Status: Accepted
- Date: 2026-11-08

## Context

ADR 0006 lets people write to a client's tables once an administrator
enables it, and shows a conflict rather than overwriting it: the update
compares the old value (`UPDATE … WHERE key = ? AND column = old`), with
SQL Server's `rowversion` where a table has one. ADR 0007 records each
write in three steps, since no transaction spans AnyGridDB's database and
the client's.

What a person saw is a value as the read engine produced it: a canonical
decimal, an instant in UTC, a link as its target's key and label.
Comparing it in SQL would need the inverse of every read projection, and
the engines compare differently: MySQL's collations fold case, SQL
Server ignores trailing spaces, floating-point columns round.

## Decision

- **An administrator enables writes per exposed table**, in three
  switches: editing, adding, and deleting rows. The source's account is
  introspected again when they change: a right it lacks is refused, and a
  column takes writes only when AnyGridDB writes its type back exactly and
  the account may update it. A table without a primary key stays
  read-only.
- **A change is compared under lock.** The write's transaction locks the
  rows (`FOR UPDATE`; `UPDLOCK, HOLDLOCK` on SQL Server), reads them
  again through the read engine, and compares each field the person
  changes with what they saw, as the read engine returns it. If one
  moved, nothing is written and the person is told; the grid shows the
  current value. A write without what was seen (an API client that does
  not send it) is not compared.
- **Conflicts are per field, not per row.** Two people changing different
  fields of a row do not conflict, so `rowversion` is not used.
- **A value is written in its column's own type**, the inverse of the
  read: an instant goes back to the source's zone for a date and time
  without one, a whole-number column refuses a fraction before anything
  is sent, a link writes the client's own foreign key. MySQL and MariaDB
  sessions run with `STRICT_ALL_TABLES`: a value a column cannot hold is
  refused, never cut.
- **What the engine refuses is said plainly**, per engine: a required
  value, a duplicate, a missing linked row, a check, text too long, a
  right the account lacks, a row another write holds, and the message a
  client's own trigger raises. The field's label replaces the column's
  name.
- **Three steps, in append-only tables** (`external_writes`,
  `external_write_steps`), not in `audit_events`, whose rows are named by
  a uuid and never change:
  1. the intent (who, which row, what it held under lock, what was asked),
     committed before the client's transaction commits;
  2. `applied` once it committed, with the row as the write's own
     transaction read it back, and in the same control-plane transaction
     the row events webhooks and automations wait for;
  3. `confirmed` once a job reads the row again and finds the write, or
     finds that a later write through AnyGridDB read it under lock.

  A write the client rolled back is `abandoned`. An intent with no outcome
  after fifteen minutes, as a crash or a lost connection leaves, is settled
  by reading the row: `applied` and `confirmed` if it holds the new values,
  `abandoned` if it holds the old ones, `unverified` otherwise.

- **A row's history shows the writes made through AnyGridDB**, with where
  each stands, and says that changes made by other applications are not
  known there.

Not yet on client tables: statuses and signatures (with their
fingerprints, ADR 0007), the row trash, imports, automations, and writing
an inverse link (the other table's foreign key).

Since then: statuses and signatures (ADR 0033), imports, the row trash,
and inverse links (2026-11-08).

An inverse link writes the other table's foreign key: linking a row sets
the key on each row added, unlinking clears it on each row removed. Those
rows change through their own table's write path, so its switches, field
and row rules, statuses, and trail apply. The link takes changes when
that table takes edits and its key may be written, whatever its own table
allows.

A row deleted through AnyGridDB stays in the table's trash for 30 days.
Putting it back adds it again with the stored values its delete recorded,
best effort, and the insert names the delete it restores (`restores`).
The row therefore leaves the trash even where the client's database gives
it a new key, as a SQL Server identity does. A column the engine fills
itself takes no value on a new row: a generated or computed column, an
identity that refuses one, a `rowversion`.

An import goes through this same write path, in batches of 100 rows with
one import event. A batch the client refuses is written again row by row:
the refused lines are reported with what the database said, and the
others are kept. Rows locked or signed are left out, and a client's
foreign key is imported as the key it holds.

## Consequences

- A write holds row locks in the client's database for the length of one
  read and one update per row, under the source's time limit; waiting for
  a row another application holds stops after ten seconds.
- A client's row history covers AnyGridDB's writes only; ADR 0007's audit
  kit remains the way to audit the others.

## Rejected

- **`WHERE column = old` in SQL.** It compares the engine's way, not the
  way the person saw the value, and an update that matches no row cannot
  tell a conflict from a missing row.
- **`rowversion`.** It turns any change to a row into a conflict.
- **Distributed transactions (XA).** As in ADR 0007.
