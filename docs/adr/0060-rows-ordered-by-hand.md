# 0060 — Rows keep the order people give them

- Status: Accepted
- Date: 2026-11-13

## Context

A row of AnyGridDB's own tables was read in the order it came, by
`ag_seq`, whenever a view sorted nothing. People could not put a row just
above another, move one, or place a card inside a kanban stack. `ag_seq`
cannot carry that order: it is the autonumber field's value and the
"Row N" a record shows, and must never change.

## Decision

- **A place of its own.** Every table AnyGridDB stores has a system column
  `ag_position` (`numeric`), indexed with `ag_seq`. Rows are read by
  place, then by sequence; a view's groups and sorts still come first. The
  migration gives each existing row its sequence number as its place, so
  no table changes order.
- **New rows go last.** A row takes the next value of `ag_row_position`,
  one sequence for every table, so it comes after every row placed so far.
- **Between two rows, nothing renumbered.** A row put just before or just
  after another takes a number strictly between that row's and its
  neighbour's, with as few decimals as the gap needs
  (`ag_row_positions`): putting rows in one gap again and again adds about
  a third of a digit each time. Before the first row, whole numbers under
  it; after the last, the sequence's next values. Placing rows in a table
  holds a transaction lock on that table's order, so two people placing a
  row in one gap get two places.
- **A move is not an edit.** Moving rows changes their place only. The
  audit trail records it as an update whose only difference is the place;
  the row's last change and its author stay as they were; no webhook,
  automation or notification hears of it; open tabs read the table again.
  A locked or signed row stays where it is, and rows can still be put
  beside it.
- **A restored row comes back at its place**: its snapshot carries it, or,
  deleted before this change, its sequence number.
- **Client tables keep their database's order** (by key): a client's row
  cannot be placed.
- **In the app:** insert a row above or below another, and move a row up or
  down, from the grid's row menu; drag a row by its gutter; drop a card on
  another card of a kanban, in its stack or another. All only while the
  view sorts nothing; the grid also not while it groups. Each move can be
  undone.

## Consequences

- `ag_seq` stays the row's number for ever: the autonumber field and the
  record panel's "Row N" show it. The grid's gutter numbers its lines in
  the view's order instead, as a spreadsheet does, so a row moved up
  takes the number of the line it lands on.
- Copies, snapshots and exports read rows in this order, so the order
  travels with them.
- Lookups list a linked table's values by sequence, not by place: a move
  changes no formula result.
