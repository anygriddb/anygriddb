# 0016 — Field and row rules are enforced by the read engine

- Status: Implemented
- Date: 2026-11-07

## Context

The first implementation of field and row rules applied them per endpoint,
and missed surfaces:

- `rows.get` returned hidden fields;
- REST, exports, dashboards, webhooks, and history ignored the rules;
- writes outside the row rule were allowed;
- lookups and rollups from other tables read hidden values;
- filters on a hidden field revealed it.

## Decision

- **The read engine receives the reader's rules** (`EngineCatalog.access`).
  - A hidden field compiles to empty in the page, formulas, lookups and
    rollups from other tables, filters, sorts, search, groups, and
    aggregates. It is left out of responses and of the catalog.
  - A row rule is AND-ed into every read of its table, through links and
    rollups too. It reads real values, even of fields the reader cannot see.
  - A rule that no longer compiles keeps no row.
- **One entry point builds the engine** for every read made on behalf of a
  person: `readerEngine()` in `apps/api/src/data/acl.ts`.
- **Writes check two things**: the fields must be writable
  (`assertFieldsWritable`), and the rows must be inside the rule
  (`assertRowsInScope`). This covers updates, deletes, links on both sides,
  statuses, signatures, comments, and history.
- **Collaborators with rules cannot use the row trash.** Its snapshots hold
  every field.
- **Rule changes are audited** like roles (migration 0018). Revoking a
  member removes their rules.

## Consequences

- A new surface is safe by construction as long as it builds its engine
  with `readerEngine()`.
- The same contract carries over to external sources (ADR 0006): rules
  compile into the query the source runs.
