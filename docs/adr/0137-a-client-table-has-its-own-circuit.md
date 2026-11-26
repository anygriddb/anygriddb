# 0137 — A client's table has a circuit of its own

- Status: Accepted
- Date: 2026-11-26
- Relates to: 0033 (statuses on a client's rows), 0124 (configurable status
  circuits), 0130 (whose decision that a client's table keeps compliance
  this replaces), 0118 (seal formats)

## Context

A table of AnyGridDB's own takes any circuit (ADR 0124); a client's table
was held to compliance (ADR 0130), because its statuses were written in
compliance's words beside the client's rows: `submitted`, `locked`,
`signed`, and draft as no entry. A team that reviews a client's records
in two hands, or approves them before they are paid, had a circuit it could
draw for its own tables and not for the records it reviews most.

What a client's table cannot do is what AnyGridDB's own tables do in their
database: refuse a write that another application makes. Its rows are the
client's, written by whoever the client lets write them.

## Decision

- **A client's table whose rows a key names takes any circuit**, saved by
  the same editor and the same function of the database's owner
  (`ag_save_status_circuit`). A row's state is kept beside it
  (`external_statuses`), and no entry is the circuit's first state,
  whichever it is. A table without a key has no states, as before
  (`external_table_no_key`), and its editor says why.
- **What a state says is held of AnyGridDB's writes**: a state that does not
  let rows change, or only some fields, refuses AnyGridDB's change of
  them, and one that does not let rows go refuses their delete
  (`stateAllows`, the rule the native trigger keeps). A write asks before
  anything and again once its intent is recorded.
- **A sealed state seals the row**, whichever step enters it: the state is
  taken first, the writes recorded before are waited for, then what the
  row holds is sealed with its fingerprint, and a check compares it with
  the database afterwards, as the lock did. The state the row left is kept
  beside it until the seal is taken (`fenced_from`): a step whose process
  stopped goes back there, and no other step is taken until the seal is
  (`source_row_busy`). A step from a sealed state to another (a
  signature) holds only while the row still holds what was sealed; a step
  to a state that seals nothing takes the seal away.
- **A step asks what it asks on AnyGridDB's rows**: its reason, its fields
  filled (read from the client's row), another hand than the last step's,
  a signature with its proof. The signature names the seal it signs when
  there is one. The trail keeps every step (`external_status_events`), its
  reason, the states it moved between, and what a seal held.
- **What other applications do is watched, not stopped**: the editor says
  so on a client's table, and says too when AnyGridDB writes none of its
  rows, where a state's rules hold nothing back.

## Consequences

- Compliance stays the circuit a client's table starts with: its rows and
  their statuses mean what they meant.
- The seal's constraint names no state: a date of a seal goes with its
  fingerprint, whatever the state is called.
- A state that is not writable and not sealed refuses AnyGridDB's writes
  only: a change made elsewhere to a row in it is not found, as nothing of
  it was sealed.

## Rejected

- **Sealing every state that is not writable**: a fingerprint and a check
  for a state the circuit's author did not ask to seal; a state that must
  be held is sealed.
- **A column of states in the client's table**: AnyGridDB never adds one to
  a table the client had (ADR 0006).
