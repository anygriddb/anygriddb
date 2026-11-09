# 0033 — Statuses and signatures on client rows: kept by AnyGridDB, sealed by a fingerprint

- Status: Accepted
- Date: 2026-11-08

## Context

On AnyGridDB's own tables, a row moves from draft to submitted, locked,
and signed. A column holds its status, and a trigger refuses any change
to a locked or signed row (ADR 0007). A signature asks for the signer's
password again and records the meaning they give.

A client's table has no status column, and AnyGridDB never adds one
(ADR 0006). Other applications write to it without AnyGridDB. ADR 0007
therefore splits the guarantee. On a client's row, AnyGridDB refuses the
writes made through it, and a SHA-256 fingerprint of the signed values,
checked on a schedule, detects a change made elsewhere and raises an
alert. ADR 0028 left statuses and signatures out of the first writes.

People sign rows they cannot edit too. A quality manager approves the
orders of an ERP that AnyGridDB only reads.

## Decision

- **A client row's status lives in AnyGridDB's database**
  (`external_statuses`). There is one entry per row that left draft, named
  by the row's key as text. It does not live in the side table
  (ADR 0032): the client's DBA can write there, and a status must work
  without a side schema. Like `ag_status` on AnyGridDB's own tables, it
  is not a field that filters or sorts.
- **The workflow is the same on both storages.** An editor submits a draft
  row. An owner locks a submitted row, signs a locked one after typing
  their password again, and unlocks a locked or signed one back to
  draft. A status needs a key. It does not need the table's write
  switches: locking and signing do not write to the client's database.
- **Locking seals the row.** AnyGridDB reads it with every stored field:
  the client's columns, links as the key they hold, and AnyGridDB's own
  fields. Formulas, lookups, and rollups are left out, as they follow
  other rows. It keeps those values in a canonical form, plus the SHA-256
  of that form. The canonical form puts fields in name order, writes
  numbers canonical (`12.5`), and gives instants in UTC.
- **A lock waits for the writes already under way.** A write through
  AnyGridDB records its intent (ADR 0028) and then reads the row's status.
  The lock commits the status first, then waits for every write recorded
  before it, 30 seconds at most, and only then reads the row. A write that
  read the status before the lock has therefore finished when the row is
  read. A write that reads it after the lock is refused, and its intent is
  `abandoned`. Nothing holds a connection of AnyGridDB's pool while the
  client's transaction runs.
- **AnyGridDB refuses every change to a locked or signed row** through
  every transport: edits, its own fields, deletes, and automations.
- **Signing compares first.** The row is read again. If it no longer
  matches its fingerprint, the signature is refused and the row is marked
  changed. The signature (`row_signatures`, now naming a row by text)
  records the fingerprint of what was signed.
- **Checks.**
  - A job runs every five minutes and compares sealed rows with their
    fingerprint: the oldest checked first, 2,000 rows a run at most.
  - On a table watched for changes made elsewhere (ADR 0031), a sealed
    row that a check finds changed is compared at once.
- **What a check finds.**
  - A row that no longer matches is marked changed and the trail records
    it. A row deleted elsewhere is marked missing.
  - Those who locked or signed the row, and the table's owners, are told:
    in the app, and by email if they chose it.
  - Grids show the mark, and the row's panel names the changed fields with
    their sealed values. A field someone may not read stays hidden from
    them.
  - A row that holds its sealed values again is marked restored.
- **Owners decide what follows.** Nothing is sealed again by itself. An
  owner unlocks the row, and locks and signs it again. The earlier
  signature stays in the trail.
- **The trail is append-only** (`external_status_events`). It records
  submit, lock (with the sealed values and their fingerprint), sign,
  unlock, changed, and restored. A row's history shows these entries
  with the writes made through AnyGridDB. Webhooks and automations
  receive the same `status` event as from AnyGridDB's own rows.

## Consequences

- AnyGridDB's database keeps a copy of each sealed row's stored values.
- A change made elsewhere is detected, not prevented. It is seen within
  five minutes, or within the watch interval on a watched table. The
  audit kit of ADR 0007 remains the way to refuse such changes in the
  client's database.
- A field removed from AnyGridDB after the lock is no longer compared. A
  field added after it is not sealed.
- A type change the DBA makes that changes how a value reads, such as a
  date becoming a date and time, shows as a change.
- A lock waits up to 30 seconds when a write on the row is under way.

## Rejected

- **The status in the side table.** Anyone with rights on the side schema
  could unlock a row, and statuses would need a side schema.
- **Holding a lock in AnyGridDB's database across the client's write.**
  Every write in progress would pin a connection of AnyGridDB's pool.
- **Keeping only the fingerprint.** An alert could not say which fields
  changed.
- **Triggers in the client's database to refuse changes.** AnyGridDB
  changes no client schema; this stays the DBA's audit kit (ADR 0007).
