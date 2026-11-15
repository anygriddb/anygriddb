# 0093 — Opens of a table on the change trail

- Status: Accepted
- Date: 2026-11-16
- Relates to: 0069 (trail retention), ROADMAP #31

## Context

Exports already name who took rows out of the instance. A read of every
page of every table would write an event on each open, so the trail would
grow without end and "last changed" on the home would stop meaning a
write. Some tables still need to say who opened them.

## Decision

- **Opt-in per table, off by default.** A manager turns it on from the
  table's rename dialog (`trail_reads` on `data_tables`). Nothing records
  an open until then.
- **One action: `open`.** Distinct from `access` (an administrator opening
  a base they are not a member of) and from `export`. The event names the
  table; it keeps no value and no filter.
- **Written when the person opens the table in the app**, through the
  same call that records their recent tables. At most one event per person
  and table in an hour.
- **Excluded from "last changed"** on the home, with exports. Shown on the
  change trail in Administration, and on a base's activity for members who
  may read that table.

## Consequences

- A table that turns the setting on starts recording from then; past opens
  are not reconstructed.
- API and MCP reads of rows do not write an open: the trail answers who
  opened the table in the product, not every query.

## Rejected

- Recording every `rows.read`: floods the trail and mixes a page open with
  a token's polling.
- Reusing `access`: that action already means an administrator's emergency
  opening of a base.
