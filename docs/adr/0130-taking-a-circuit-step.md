# 0130 — Taking a circuit's step is a permission, and a step names its roles

- Status: Accepted; that a client's table keeps compliance is superseded
  by 0137
- Date: 2026-11-25
- Relates to: 0124 (configurable status circuits, amended), 0127
  (permissions of a base), 0128 (made roles), 0129 (rows leave by export)

## Context

ADR 0124 gave each table a circuit and promised that "may validate" would
be given the way "may export" is, by a permission named `rows.transition`,
to the roles a step lists, "shipped or custom", with `contributor` among
the shipped packs. The code that landed did otherwise:

- no permission `rows.transition`: a step asked `rows.write`, and the old
  lock and sign `rows.lock`, so nobody could validate without being able to
  edit rows or lock them;
- a step listed only the keys of the four roles, and the shipped circuits
  also named `contributor`, which is no role here and matched nobody;
- a step's required fields were read from values no caller sent, so a step
  that required one was always refused;
- a step signed `step_up` asked a password like any other;
- neither the REST API nor MCP could take a step, no automation could start
  on one, and a webhook told a step without its states;
- a client's table could be given a circuit whose states its statuses
  cannot hold.

## Decision

- **`rows.transition` is the permission to take a circuit's steps at all.**
  The editor's and the owner's packs give it, as they took steps before; no
  made role gets it until an administrator ticks it.
- **A step names who takes it:** one of the four by its key, as before, or
  a made role (`status_transition_grants.made_role_id`, migration 0141). A
  made role that takes steps also takes those named for editors when it
  writes rows, and those named for owners when it locks them. So a role
  of "read, take steps", named on an approval, validates without editing
  or locking.
- **Each step's demands are checked as the row stands:** its reason, the
  fields it names (read from the row under its lock), four eyes against
  the actor of the row's last step, and its signature: a password, or for
  `step_up` a password or second factor. A refusal names what is missing
  (`reason_required`, `value_required` with the field, `four_eyes`,
  `meaning_required`, `invalid_credentials`).
- **A token signs nothing** (`signature_in_app`): a signature is its
  signer's proof, and a token proves nothing of its holder. Other steps are
  taken through REST (`POST /api/v1/tables/:tableId/records/:id/transition`)
  and MCP (`transition_record`), with the caller's roles; the API's
  document names each table's states and steps.
- **A step is an event:** its row event carries the states it left and
  took; a webhook's payload adds them with the step's key; an automation
  may start on any step, or on the one it names (`step_taken`).
- **A client's table keeps the compliance circuit** (ADR 0033): its
  statuses are written in those words beside the client's rows.
- `contributor` grants are removed; the old `assertStatusTransition`, which
  nothing called, is gone.

- **A table's circuit is edited** from the table's own menu, by whoever
  manages its structure (`schema.manage`): it starts from the circuit in
  place or a shipped one; states (first, writable, deletable, sealed) and
  steps (from, to, reason, fields, signature, four eyes, who takes it:
  owners, editors, made roles that take steps). It is saved by the
  database's owner (`ag_save_status_circuit`, migration 0142) under the
  rules a template's application kept: no row leaves a sealed state, a
  state rows are sealed in stays sealed, rows of a state that goes move
  where the editor says, and the change is on the trail. A shipped circuit
  is applied the same way, from its definition: the function that copied a
  template (`ag_replace_status_circuit`) is gone.

## Still to do from ADR 0124

- A row's state as a field filters, sorts and groups read: ROADMAP 114.

## Consequences

- Nobody holding one of the four roles gains or loses a step.
- A made role that wrote rows or locked them takes no step after the
  upgrade until **Take a circuit's steps** is ticked on it.
- A step that requires fields works for the first time.
