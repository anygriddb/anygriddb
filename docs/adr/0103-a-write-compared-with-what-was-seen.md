# 0103 — A write to AnyGridDB's own table is compared with what its author saw

- Status: Accepted
- Date: 2026-11-17
- Relates to: 0028 (a client's table compares under lock), 0049 (which
  left conflicting writes as a separate question), 0089 (putting a value
  back compares too)

## Context

On a client's table a write is compared with what its author saw, and
refused when the value moved (ADR 0028). On AnyGridDB's own tables the
last write won: two people changing one cell were told nothing, and the
first one's value was gone. Realtime narrows the window, it does not
close it: a page reads a change a moment after it is made, and an editor
left open keeps showing what it opened on while the row under it is read
again.

## Decision

- **A write that says what its author saw is compared.** The rows are
  locked, read again through the read engine as the author's page read
  them, and compared field by field. A field that holds something else
  refuses the whole write (`row_conflict`, 409, naming the field), and
  nothing of it is written.
- **By field, not by row.** Two people changing different fields of one
  row do not meet, as on a client's table.
- **Only the fields written are compared.** The author may read them,
  since they may write them. What a request claims to have seen in
  another field is not looked at: a guess learns nothing about a field
  hidden from its author.
- **A write that does not say is written as before.** An automation, an
  import, a form, and an API client that sends no `expected` are not
  compared. The public API and the MCP server take `expected` on every
  table.
- **What was seen is what the editor opened on.** A text, a date, and a
  rating are typed over the value shown when their editor opened, and
  that value is what the write is compared with, whatever the page read
  since. A list, a person, and a file follow the cell while their panel
  is open, and a paste, a fill, and a card moved act on what the page
  holds: those send that.
- **Compared as the field keeps a value** (`sameAsSeen`). A page holds a
  value as it was read, or, until it reads the row again, as its own
  last write sent it. A file is read with its name and size and written
  as its key; a document is read as an object and written as text; an
  empty cell is nothing, an empty text, or an empty list. Both sides are
  brought to what the field keeps, so that changing a cell twice in a
  row is never refused for the form of one's own write.
- **Refused, the page shows what the row holds.** The cell goes back, the
  row is read again, and the person is told to make the change again if
  it is still wanted.

## Consequences

- One more read of the rows written, of the fields compared alone, inside
  the write's transaction.
- A link is not compared: it is set through its own path, and a link
  from another table changes it without touching the row.
- An undo is a write like another: it says what the page holds, and is
  refused when someone changed the value since.
- Putting a value back (ADR 0089) keeps its own comparison, with the
  stored row, which also covers a whole row by its last change.

## Rejected

- **A version number on the row.** Any change to a row would refuse
  every other, two people filling two fields included, which is what
  people sharing a table do all day.
- **Comparing every write.** An automation or an import has seen
  nothing: there is nothing to compare with, and refusing them would
  stop what runs unattended.
- **Merging the two changes.** There is no telling which a person would
  keep; they are shown the value and decide.
