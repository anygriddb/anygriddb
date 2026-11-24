# 0124 — Configurable status circuits

- Status: Accepted
- Date: 2026-11-24

## Context

Every row follows one fixed path today: draft → submitted → locked →
signed, with unlock back to draft. The allowed steps live in
`assertStatusTransition` (`packages/core/src/schemas.ts`) and again in
the audit trigger (`ag_audit`), which refuses any write or delete on a
locked or signed row. Client tables keep the same path in
`external_statuses` and seal locked or signed values (ADR 0033). Who may
take which step is tied to the old role ladder (editor submits; owner
locks, signs, unlocks).

Hospitals, banks, and government instances need other paths: a simple
review, a dual approval with four eyes, a circuit a table manager
defines. They also need the guarantees to stay in the database: a
compromised API must still fail to rewrite a sealed row or erase a
signature. The unified authorization model, when it lands, can grant
“may take a transition” the way it grants “may export”, but it does not
yet know what a circuit is.

Roadmap: this record opens configurable validation; it amends ADRs 0007
and 0033 where status values and the lock rule are named, and the
unified authorization's permission catalogue once that lands.

## Decision

### Circuit

A **status circuit** belongs to one table. It is a named set of **states**
and **transitions**.

- Exactly one state is **initial**. A new row is born in it (native
  `ag_status` default; client rows with no `external_statuses` row read as
  that initial state).
- Each state has a stable `key` (text stored on the row) and a label.
- Each transition has a stable `key`, a from-state, a to-state, and a
  label. Several transitions may leave the same state. Cycles are
  allowed when the manager draws them.

Shipped circuits are **immutable templates**. Applying one to a table
**duplicates** it onto that table. The table then owns its copy and may
edit it. Duplicating a template or another table’s circuit makes a new
copy; templates themselves are never edited.

### State rules

Each state says what a row in it allows:

| Rule              | Meaning                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `row_writable`    | Cell values may change (subject to field rules and `writable_fields`)                                                                            |
| `writable_fields` | `null` = every field the person may write; `[]` = none; otherwise an allow-list of column names                                                  |
| `allow_delete`    | The row may be deleted (or trashed)                                                                                                              |
| `seal`            | While the row is in this state its stored values are sealed (ADR 0033 on client tables; native tables refuse edits when `row_writable` is false) |

A transition never writes cell values; it only changes status (and may
append a signature). Entering a state with `seal` takes the fingerprint
on client tables the way today’s lock does.

### Transition requirements

Each transition may require any combination of:

| Requirement      | Meaning                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `require_reason` | A non-empty reason (≤ 500 characters), recorded on the trail                                                               |
| `require_fields` | Named columns must be non-blank on the row before the step                                                                 |
| `signature`      | `none`, `password` (re-enter password), or `step_up` (password or second factor as Administration sets for sensitive acts) |
| `four_eyes`      | The actor must differ from the actor of the **previous transition** on this row (insert is not a transition)               |

A transition with `signature` other than `none` appends a
`row_signatures` row (meaning required) and never deletes earlier ones.
Signing today (locked → signed) becomes a transition with
`signature = password` on the compliance circuit.

### Who may take a transition

That model gains a base permission:

| Permission        | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `rows.transition` | Take a status transition the table’s circuit grants this role |

`rows.write` no longer covers submit; `base.manage` no longer covers
lock, sign, or unlock. Those acts go only through `rows.transition`.

Each transition lists the **roles** (shipped or custom) that may fire it.
An actor needs both `rows.transition` on the scope and a role listed on
that transition. Shipped packs that today submit or seal gain
`rows.transition` (`contributor`, `editor`, `owner`). The compliance
circuit’s grants reproduce today’s who-can-what: submit for
contributor/editor/owner; lock, sign, and unlock for owner only.

### Shipped templates

| Key             | Purpose                                                                 | States (keys)                                        | Notable transitions                                                    |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `compliance`    | Today’s path; **default** on every table at migration and on new tables | `draft` → `submitted` → `locked` → `signed`          | submit; lock; sign (password); unlock to `draft`                       |
| `simple_review` | One reviewer                                                            | `draft` → `in_review` → `approved`                   | submit; approve; reject back to `draft`                                |
| `dual_approval` | Two approvals, four eyes on the second                                  | `draft` → `submitted` → `approved_once` → `approved` | submit; approve_first; approve_second (`four_eyes`); reject to `draft` |

On `compliance`: `draft` and `submitted` are writable and deletable;
`locked` and `signed` have `seal`, are not writable, and are not
deletable — identical to today. On `simple_review` and `dual_approval`,
the terminal approved state is sealed and frozen; review states are not
writable.

### Row storage

- Native tables keep `ag_status text NOT NULL`. The fixed
  `CHECK (… IN ('draft', …))` is replaced by a trigger check against the
  table’s circuit states. The default remains the circuit’s initial key
  (`draft` on compliance).
- Client tables keep `external_statuses.status` the same way (ADR 0033).
- Status becomes readable by filters, sorts, groups, and views as a
  system column (amends ADR 0033’s “not a field that filters or sorts”).
  It is still not a user field: it cannot be deleted or retyped.

### Database guarantees

Held in PostgreSQL, not only in the API:

1. **No write of cell values** when the row’s state has
   `row_writable = false`, or when a changed column is outside
   `writable_fields`. Same exception as today: a status-only update that
   follows an allowed transition.
2. **No delete** when `allow_delete = false`.
3. **No status change** except along a transition of the table’s circuit,
   status-only, with `anygrid.action` equal to that transition’s key (and
   `anygrid.unlock` only where the destination is writable and the source
   was not — generalized unlock). Inserts still start at the initial
   state only.
4. **`audit_events` and `row_signatures` stay append-only** under the
   same flags as today (ADR 0119). Signatures are never removed by a
   transition or a circuit edit.
5. **Client seals and change detection** stay as ADR 0033 / 0118: a state
   with `seal` seals on entry; checks compare fingerprints; owners decide
   what follows. The hard-coded names `locked` / `signed` in jobs become
   “states with `seal`”.
6. **The application reads circuits and never writes them.** The trigger
   takes its rules from `status_circuits`, `status_states`,
   `status_transitions` and `status_transition_grants`: a role that could
   rewrite them could unseal a signed row with no event. The role the
   application signs in as may only read them (`grantRuntimeRole`). A
   table's circuit changes only through the owner's
   `ag_replace_status_circuit`, which refuses to move a row out of a
   sealed state, refuses a circuit that would no longer seal rows sealed
   now, records each row it moves as a `transition`, and puts the change
   itself on the trail. Only whoever owns the table may move rows that
   way: the application setting `anygrid.action` to `remap` gets nothing.
7. **A table with no circuit of its own follows the shipped
   `compliance` circuit,** for the trigger and for what a dropped column
   may hold, as every table did before circuits.

The API and MCP still check permissions, reasons, signatures, four eyes,
and required fields first; the database is the backstop.

### Editing a circuit in service

A manager with `schema.manage` edits the table’s circuit copy.

| Change                                  | Rule                                                                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rename labels, reorder                  | Always allowed                                                                                                                                                                           |
| Add a state or transition               | Allowed                                                                                                                                                                                  |
| Remove a transition                     | Allowed (rows hold a state, not a transition)                                                                                                                                            |
| Change state rules                      | Takes effect on the next write                                                                                                                                                           |
| Change transition requirements          | Takes effect on the next attempt                                                                                                                                                         |
| Change transition role grants           | Takes effect on the next attempt                                                                                                                                                         |
| Remove a state                          | Allowed only with an explicit map of every removed key → a remaining key; rows are moved in the same transaction before the state goes. Refused if any row would be left without a state |
| Change the initial state                | Allowed; existing rows keep their state                                                                                                                                                  |
| Replace the table’s circuit             | Allowed only if every distinct status present on the table exists as a key in the new circuit, or an explicit full map covers them. Refused otherwise                                    |
| Delete the only state                   | Refused                                                                                                                                                                                  |
| Leave the circuit with no initial state | Refused                                                                                                                                                                                  |
| Edit a shipped template                 | Refused; duplicate first                                                                                                                                                                 |

A refused edit changes nothing. Remaps and circuit replacements are
audited.

### Surfaces

| Surface                       | Behaviour                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Table settings                | Circuit picker (templates + duplicate), then the editor (states, transitions, grants, requirements)                                                                |
| Grid and row panel            | Actions for transitions the actor may take from the row’s state; signature / reason prompts as required                                                            |
| Filters, sorts, views, kanban | Read `ag_status` / external status by state key and label                                                                                                          |
| REST, tRPC, MCP               | `rows.transition` (table, row, transition key, reason, proof); legacy `setStatus` / `sign` keep working as aliases on the compliance keys during one major version |
| Automations and webhooks      | Trigger and payload on a completed transition: from key, to key, transition key, actor                                                                             |

### Migration

1. Add circuit tables; seed the three templates.
2. For every existing table, duplicate `compliance` and point the table at
   that copy. Every row keeps its `ag_status` / external status value.
3. Rewrite the audit trigger and client status path to honour the circuit
   while `compliance` semantics match today’s hard-coded path.
4. No UI change in that first step: the product looks and behaves as
   before. The editor, the new transition entry points, and the extra
   templates follow in the same version once the model is in place.

### Schema (sketch)

```
status_circuits (
  id, table_id null for templates, key, name,
  system, duplicated_from_id, created_at, updated_at
)
status_states (
  id, circuit_id, key, label, is_initial,
  row_writable, writable_fields, allow_delete, seal, position
)
status_transitions (
  id, circuit_id, from_state_id, to_state_id, key, label,
  require_reason, require_fields, signature, four_eyes, position
)
status_transition_grants (transition_id, role_id)

-- One circuit per table via status_circuits.table_id (unique).
-- No circuit_id on data_tables: that would cycle with ON DELETE.
```

## Consequences

- Every table carries its own circuit copy; templates are only seeds.
- The unified authorization's packs and screens gain `rows.transition`; Access can grant
  “may validate” without making someone a base manager.
- Status appears in filters and views; saved views that never mentioned
  it are unchanged.
- Jobs and structure guards that name `locked` / `signed` switch to
  `seal` (and to `row_writable` / `allow_delete`) so custom circuits keep
  the same protections.
- A first release can ship the model and migration with no visible
  change, then the editor and transition UI.

## Rejected

- **One global circuit for the instance.** Circuits differ by table
  (orders vs incidents).
- **Status as an ordinary single-select field.** It would be deletable and
  would leave the audit trigger; seals and signatures need a system
  column the database owns.
- **Guarantees only in the API.** A stolen application role must still
  meet the trigger (ADR 0119).
- **Editing shipped templates in place.** Instances that rely on
  `compliance` would drift; duplicate, then edit.
- **Silent remap when deleting a state.** An operator must say where
  rows go; otherwise the edit is refused.
- **Four eyes against the row’s creator.** The requirement is a second
  **transition** actor, not “not the author of the row”.
