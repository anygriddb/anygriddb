# 0076 — Base snapshots carry their rows line by line

- Status: Accepted
- Date: 2026-11-14
- Relates to: 0039 (files and people in snapshots), 0064 (imports read as
  they are written), 0065 (table copies in SQL)

## Context

A base snapshot kept its rows in one JSON document, written whole and,
when it was imported, parsed whole before its first row was written. The
rows' ids were mapped to new ones in memory, and each row's links were
set one at a time. A snapshot stopped at 100,000 rows, and so did a base
copied through one (ROADMAP row 83). Writing the JSON as a stream would
not have been enough: its import still needed the whole document.

## Decision

- **Version 3 of the format.** `snapshot.json` keeps the schema, the
  views, the members, the files' list, and each table's row count. Each
  table's rows are the lines of their own entry, `rows/<key>.ndjson`,
  deflated: one JSON object per row, with its cells by field name, its
  sequence number (`__seq`) and place (`__position`), and, under each
  link's name, the sequence numbers of the rows it links to. A snapshot
  with data is always an archive; without data it stays one JSON file.
- **Read by sequence number.** Export reads a table a thousand rows at a
  time, past the last number it wrote, then asks the read engine for
  those rows' values. A row added or removed while it reads is written
  once or not at all, never twice, and the last pages cost what the first
  did.
- **Rows keep their number and their place.** Import writes the rows 500
  at a time with the numbers and places they had, as a table copy keeps
  its own (ADR 0065), then starts the table's sequence past them and moves
  the sequence that places new rows past their highest place, so that a
  row added afterwards goes last. Rows get new ids; the number they keep
  pairs each with its line, and no map of old ids to new ones is held
  anywhere.
- **Links in bulk.** Once every table's rows exist, each link reads its
  table's lines again and makes up to 5,000 links a statement, by
  sequence number, through the foreign key or the junction. A
  many-to-many link records each linked row's change in the trail, as a
  person setting it would; a foreign key's change is recorded by its
  table's trigger.
- **Bounded by the operator's ceilings.** A snapshot writes at most
  `EXPORT_MAX_ROWS` rows and an import reads at most `IMPORT_MAX_ROWS`,
  all tables together; a copy of a base takes the smaller. A larger base
  is refused before anything is written, with a message of its own.
- **Checked at upload, read again in the job.** Every rows entry of an
  uploaded archive is read through for its size and CRC before the
  archive is accepted. The job reads each entry once for its rows and
  once more for each of its links, a line at a time, each line checked
  against the format. A count that differs from the lines, two lines
  with one number, or a broken entry refuses the snapshot, and the
  half-made base is removed.
- **Versions 1 and 2 still import**, their rows inside the JSON, up to
  100,000 rows as before.

## Consequences

- On generated rows in a test database, 500,000 rows with a link on one
  in ten were written in about 7 seconds into an archive of 5.6 MB and
  read back in about 24 seconds, with the API's memory the same as for
  250,000.
- A snapshot with data is a `.zip` even when it holds no file.
- The temporary folder holds one archive per snapshot job running.
- A table copy and a snapshot pair rows the same way: by the sequence
  number they keep.

## Rejected

- **The JSON written as a stream.** Its import would still read it whole.
- **Keeping the rows' ids.** Two bases would hold rows with one id, which
  a row id field shows (ADR 0063); the sequence number pairs rows without
  that.
- **A map of old ids to new ones, in memory or in a table.** Memory grows
  with the rows, and a table costs a write per row; the number a row
  keeps costs nothing.
- **Pages by offset, as the export of a view reads.** A row added or
  removed while it reads shifts every later page: a row could be written
  twice, which an import that keeps numbers must refuse.
