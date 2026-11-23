# 0119 — The change trail answers to the role that owns it

- Status: Accepted
- Date: 2026-11-23

## Context

The trail is what an audit reads: who changed what, who signed. Triggers keep
it append-only, with three exceptions: the retention purge, an account's
erasure, and migrations. Each was opened by a session setting named
`anygrid.*`, and PostgreSQL lets any session write such a setting. A session
that could reach the database could therefore delete an event, give it to
another author, or change the catalog and leave no event.

The application also signs in as the role that owns its tables. The owner of a
table can disable its triggers, and can rewrite a column with `ALTER COLUMN …
USING`, which fires no row trigger: tried on PostgreSQL 18, a signed row took a
new value, stayed signed, and the trail did not move.

## Decision

- **A flag counts only for the role that owns the trail.** The trail's triggers
  ask `ag_role_owns_store`. A migration's flag is read against the role the
  session signed in as.
- **The purge and the erasure are functions of the owner**, the only code that
  sets their flags, and each holds its limits. The purge takes nothing younger
  than the shortest retention an instance can choose, whatever date it is
  given. The erasure moves an account's trails and deletes the account in one
  step: an author cannot be taken off the trail of an account that stays.
- **This is the first step of a separation.** What the application changes
  in its tables goes through typed functions of the owner. Migrations run apart
  with the owner's credentials (`anygriddb database prepare`), and an
  application whose role owns no table only checks that they ran. A Compose
  install signs in as that role, `anygriddb_app`, with a password made once
  beside the services' certificates. The one-shot `prepare` service alone
  holds the owner's credentials.
- **An index is not built before the start.** On a very large table it can
  take hours. The application names what is missing, files are served
  correctly meanwhile, and `docker compose run --rm indexes` builds it.

## What this does not do

An instance that still signs in as the owner, on a PostgreSQL of its own, gets
nothing from these checks: that account is the owner. It says so in its start
log and in Administration > Health.

The application stays the authority on who acts, since it says so to the
database. A stolen application account could still add an event or a signature
in someone's name. It could not delete or rewrite what is there, nor change a
signed row without leaving a trace.

## Rejected

- **A chain of hashes alone.** It detects and does not prevent, and its key
  would live in the container it protects against.
- **An event trigger that refuses `DISABLE TRIGGER`.** It needs a superuser,
  which a managed PostgreSQL does not give, and leaves `ALTER COLUMN … USING`
  to the table's owner.
