# 0046 — Enrichment fields in the control plane when no side schema

- Status: Accepted
- Date: 2026-11-10
- Amends: [0032](0032-fields-added-to-client-tables.md), [0006](0006-external-sources.md)

## Context

ADR 0032 put enrichment fields in a side table of the client's database
so they filter, sort, and group in the same engine. Without that grant,
adding a storage field was refused. Operators often cannot get a side
schema quickly; people still need notes and scores on ERP rows.

## Decision

- **Prefer the side schema** when the administrator names one: ADR 0032
  unchanged for that path.
- **Without a side schema**, storage fields of the same types live in
  AnyGridDB's PostgreSQL (`external_enrichment_values`), keyed by
  `(table_id, row_id)` like statuses (ADR 0033). The client's tables are
  still never altered.
- **Reads** fetch the client's page, then merge control-plane values by
  row id, for the fields asked and visible to the reader (field rules).
- **A view's filter** on those fields resolves matching keys in
  PostgreSQL first, then constrains the client query: equality (text
  without case) and emptiness, combined with AND, at most 1,000 matching
  rows (`control_plane_filter_broad` past that, never a silent cut).
  **Sort and group** are refused (`control_plane_sort`). **Any other
  filter** (automations, webhooks, row rules, link choices) is refused
  (`control_plane_filter`) rather than compiled against an empty value.
  Formulas, lookups, and rollups do not read them.
- **Writes** lock the rows' bags in the control plane for the length of
  the client's write, compare what the person saw under that lock, and
  keep the three-step trail of other external writes (ADR 0028): intent
  first, then the values, then `applied`.
- **A field records where it lives** (`data_columns.external_control_plane`).
  Naming a side schema later puts only new fields in the side table;
  existing control-plane fields stay where they are until a migration tool
  moves them (not in this change). A side schema cannot change while
  fields are kept in it (`source_side_in_use`).

## Consequences

- Enrichment works without a DBA grant, with clear limits on sort/group.
- Catalog exposes `enrichment: "client" | "control_plane" | "off"`.

## Rejected

- Sorting a large live table by control-plane values in the client engine
  (impossible without a join there).
- Moving every enrichment field into the control plane even when a side
  schema exists (loses native sort/group).
