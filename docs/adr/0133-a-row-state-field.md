# 0133 — A row's state, read where a field is

- Status: Accepted
- Date: 2026-11-26
- Amends: 0124 (the state "not a user field"); carries out what 0130 left
  to do (ROADMAP 114)

## Context

ADR 0124 made a row's state a key of its table's circuit, kept in the
system column `ag_status` that the database guards, and promised it to
filters, sorts, groups and views. ADR 0130 recorded that none read it: a
person saw a row's state in its panel only, and could not ask for the rows
waiting for review, nor sort a table by where its rows stand.

## Decision

- **A field type, `row_state`, reads the state**, as a created time reads
  `ag_created_at`: a system field that owns no column and takes no write.
  A person adds it to a table to see the state in a column and to filter,
  sort and group by it; removing the field removes nothing of the state.
  A state still changes by a step only.
- **Its value is the state's key**: what a filter compares, what the REST
  API, MCP and an export give. A screen shows the circuit's word for it:
  a shipped state in the reader's language, another by its label.
- **It sorts in the circuit's order**, not by its text: the read loads the
  keys of the table's states by their position, only when such a field is
  read, and sorts by their place there. It groups by key, in that order.
- **A filter chooses among the circuit's states** (is, is not, is any of,
  is none of); a state is never typed.
- **A client's table has none:** its statuses live beside its rows (ADR
  0033), and the field is refused there as any field such a table cannot
  hold.
- **A kanban stacks by it**: its stacks are the circuit's states, in its
  order, and none apart (a row is always in one). A card dropped in another
  stack takes the step between the two states, with what the step asks (a
  reason, a signature, a confirmation when it reopens a sealed row), by the
  same flow as the row's panel; when no step the person may take leads
  there, it is said and the card stays. Whoever may take steps carries
  cards, a sealed row's included; a card is added only to the first
  state's stack, where a new row starts.

## Rejected

- **A column every table shows without a field.** Every list of fields
  (filters, sorts, groups, a kanban's stacks, the grid's columns) would
  have needed a second kind of entry beside fields.
- **The label as the value.** A state renamed in the circuit's editor
  would change what saved filters and API clients read.

## Consequences

- Migration 0145 adds the type to `field_type`; the API's document gives
  its value as a text.
- A table copied, or a base, keeps the field like any other; its values
  are the states the copy's rows take.
