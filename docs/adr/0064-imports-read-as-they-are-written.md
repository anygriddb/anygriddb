# 0064 — Imports read as they are written

- Status: Accepted
- Date: 2026-11-13

## Context

An import held its whole file three times before writing a row. The
upload was read into memory (20 MB, 10 MB for a spreadsheet), parsed in a
worker into every row at once (ADR 0025), and staged as a JSON document
of those rows; the job loaded that document whole again, coerced every
row, and only then wrote, 500 rows at a time. A file stopped at 100,000
rows. The lines an import refused were counted after blank lines were
dropped, so past the first blank line they no longer matched the file.

An export job already writes its file as it reads, up to
`EXPORT_MAX_ROWS`.

## Decision

- **The upload goes to disk as it arrives**, as attachments do: 256 MB
  for CSV and TSV, 64 MB for a spreadsheet (its shared strings are held
  while it is read), 20 MB for JSON, which is still parsed whole.
- **A first pass, in a worker, reads the whole file once** without
  keeping it: its columns (a spreadsheet's widest row and JSON's keys
  need every row), how many rows it holds, the first 20 to show, and the
  first 1,000 to infer types from. A file past `IMPORT_MAX_ROWS` (100,000
  to 10,000,000, 1,000,000 by default) is refused there, before anything
  is staged.
- **The file is staged as it came**, with what that pass found
  (`staged_uploads.meta`: format, headers, delimiter, header line, row
  count). Imports staged the old way are removed by migration 0073.
- **The job reads the file again, in a worker, a batch at a time**, and
  writes each batch in its own transaction while the worker reads the
  next one; never more than two batches are held. Each batch has a minute
  to be read; the writes between batches are not counted.
- **A select's options are found first.** When the import adds options,
  or creates a select field, the job reads the file once for them before
  the first row: every row then finds its option.
- **Keys work across batches.** An update by key reads the table's keys
  first, as before (up to 100,000 rows); a key the import adds is found
  again by the batches after it. A key repeated inside one batch still
  updates once, the last line winning.
- **A line is the file's line**: the header is line 1, blank lines
  count, a line break inside a quoted cell does not, and a spreadsheet's
  rows are numbered as the sheet numbers them.

## Consequences

- An import of a million rows holds two batches, a select's options, and
  its keys when it updates by key, whatever the file's size.
- A large file is read twice, three times when it brings select options:
  each pass is linear and much faster than the writes it feeds.
- Progress counts the lines read, so a refused line moves the bar like a
  written one.
- Upsert into a table of more than 100,000 rows is still refused: its keys
  are read into memory to compare them as the file writes them.
