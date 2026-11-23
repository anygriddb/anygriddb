# 0117 — A copy the instance makes keeps its rows' dates and status

- Status: Accepted (amends 0065, 0076, 0077)
- Date: 2026-11-22

## Context

A snapshot's line held a row's cells, its number, and its place. A restore
point and a copy of a base are snapshots, so a row read back from either had
new dates, the restorer as its author, and the status of a draft: a row that
had been locked or signed could be written again in the copy. The row's insert
trigger would have refused anything else.

An uploaded archive was also checked in two halves. Its entries were read at
upload, but a file's checksum was only compared while the base was being built,
where a mismatch became a count in the report. A row's number was accepted up
to the largest bigint, which left the imported table no number to give its next
row. A row's place had the same reach, and the sequence of places is shared by
every table.

## Decision

- **Version 4 is for what the instance keeps for itself.** It is version 3 with
  each row's status, dates, and authors under a key no field can be named. A
  restore point and a copy of a base are written in it. An export stays version
  3, and version 4 is refused from a file at upload and in the import job: what
  comes from outside is never believed on a row's history.
- **Dates and authors are written with the row.** The stamp trigger keeps them
  when the transaction asks for it (`anygrid.keep_row_state`), which only the
  copy's writer does. The links the copy then makes leave the row's last change
  as it was.
- **A table copied with its rows keeps them too**, by the same rule: a locked
  row is as locked in the copy, and a signed one comes locked, without its
  signature. Whoever may copy a table may also unlock a row, and that step is
  then on the trail, which an editable copy would have skipped.
- **A status comes back through the trail's own transitions.** A row is still
  inserted as a draft. Once its links are made, it takes the steps to where it
  was, each recorded with the source `snapshot`.
- **A signed row comes back locked, without its signature.** A signature
  attests to the row it was given to, by the person who gave it, in the trail
  of that row. The restore's report says how many rows this concerns.
- **An uploaded file is read whole before a base is made of it.** The import
  job checks every listed file against its SHA-256, and every line against its
  schema and its table's count, and refuses the file otherwise. A row that
  claims a status or a date, by a key that is none of its table's fields, is
  refused too. A file of a type this instance refuses stays counted apart.
- **A line's number and place stop at 2^53 - 1** in a file. A table goes on
  from its highest number, and every table's new rows from the highest place,
  so neither may leave them nothing to go on to. A copy the instance made of
  its own table reads whatever that table holds.
- **An instance already past those numbers is repaired by the migration.** A
  table's row whose number or place is past 2^52, which adding rows never
  reaches, is brought next to the table's others, in the order it had; the
  sequences go back to what follows the rows, the deleted ones included. The
  row triggers stand aside for these two columns only, on the tables that need
  it, as the rewrite of migration 0069 did: they say where a row stands and
  nothing of what it holds, so a locked or signed row keeps all it held, and
  the trail is not written to. A healthy instance is only read. A row brought
  back from the trash, or a restore point made before the repair, goes through
  the same bound.
- **A field may be named like a line's own keys.** A field called `__seq` or
  `__position` used to overwrite the row's number in the line, and the
  snapshot could not be read again. Its value is now kept apart, under a key
  no field can be named. A file written before this keeps what it lost.
- **A restore point stays usable when a file in it is damaged.** That file is
  left out and counted: refusing would take the rest of the base away from the
  person who needs it back.

## Consequences

- A migration replaces the stamp trigger; no table is rewritten, and only a
  table past the numbers above is written to.
- Restore points made before this version hold no state, and their rows come
  back as drafts.
- A version before this one cannot read a restore point written by this one.
- An import job reads an archive once more before writing, which takes longer
  on a large one.
