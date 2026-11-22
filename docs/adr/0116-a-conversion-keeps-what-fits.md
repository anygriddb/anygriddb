# 0116 — A conversion keeps what fits, and says what it does not

- Status: Accepted
- Date: 2026-11-22

## Context

Changing a field's type rewrote its values with one expression per storage
type. A word that was not a checkbox's became false, a text that started with
a date lost the rest, a list was cut at its commas, and two types stored alike
kept values the new field refuses. The preview counted only what became empty,
so most of this was announced as no loss. What depends on a field (a row in the
trash, a view's filter, a rollup, the field that names the rows) was not looked
at. The whole conversion ran in one transaction, under an exclusive lock, and a
large table ended on the statement limit.

## Decision

- **One rule, the cell's** (`convertCell`). A value the new field's write check
  takes is kept as it is, a text is read as a cell reads it, and anything else
  becomes empty. So a conversion takes every value a cell takes, and keeps none
  it refuses. The server applies it between a read and a write of each batch.
  Only a pair whose every value already fits changes the catalog alone.
- **The preview says it first:** values emptied, values written differently,
  examples, the zone days are read in, what stops working, and whether the
  conversion runs in the background.
- **A day and an instant meet in the zone of the person converting,** shown and
  confirmed. Without a zone, that conversion is refused, and a text with no
  offset stays empty rather than being read in a guessed one.
- **What depends on the field.** A row in the trash comes back with what still
  fits, and says how many values did not; its snapshot is never rewritten. A
  view whose filter no longer fits opens with no rows and offers to correct it,
  and its public link keeps refusing: dropping the condition would show rows
  the view keeps out. A rollup that no longer suits its target says so in its
  cell. The last field able to name the rows cannot lose that role.
- **A long conversion is a job** (`convert_column`, past 20,000 rows). The new
  values are written beside the field by batches, and a short transaction puts
  them in its place. Until then the field is untouched, so a failure leaves type
  and values as they were.
- **The table is read-only meanwhile,** by a trigger on the table: every path
  that writes is covered, and a write is refused with `table_converting`. The
  trigger stops refusing as soon as its job has ended, however it ended.
- **A write holds the types it was checked against.** It takes the table's lock,
  reads again the types of the fields it writes, and is refused with
  `field_changed` if one moved. A conversion locks writers out first.
- **"Last modified" says what happened.** Values written beside the field change
  no row: a stopped job leaves every stamp as it was. Once the field has its new
  values, only the rows whose value changed are stamped.

## Rejected

- **Keeping `false` for an unknown word, with a warning.** The value would still
  be destroyed.
- **Raising the statement limit.** It lengthens the exclusive lock, and every
  reader of the table waits behind it.
- **Rewriting the trash's snapshots.** The audit trail is immutable.
- **Keeping the table writable during a job.** It needs a synchronisation of
  each write into the new column, for a state that lasts minutes.

## Consequences

Some conversions now give empty cells where they used to give a value: this is
announced, counted, and the old value stays in the row's history. Every
conversion between a day and an instant asks for a zone. A table is read-only
for the length of a long conversion, and its fields cannot be changed
meanwhile. A job writes one audit event per row, whose source says
`conversion`, plus one for each row it stamps. The trail is append-only: a job
stopped part-way leaves the events of the rows it had reached, which change no
field.
