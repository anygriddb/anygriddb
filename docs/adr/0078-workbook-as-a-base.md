# 0078 — A workbook made a base, each sheet a table

- Status: Accepted
- Date: 2026-11-14
- Relates to: 0025 (imports read in a worker), 0037 (Airtable bases), 0064
  (imports read as they are written)

## Context

People keep data in spreadsheets, Google Sheets among them, with one
sheet per kind of thing. AnyGridDB imported a file into one table, from
the first sheet of a workbook, and a whole base only from its own
snapshots or from Airtable (ROADMAP row 100).

## Decision

- **A workbook file, not a provider's API.** The person uploads an
  `.xlsx` file, as Google Sheets (File, Download, Microsoft Excel),
  Excel, and LibreOffice save one, and gets a new base. A spreadsheet
  kept elsewhere is downloaded by its owner, who can read it already.
- **Read twice, never whole** (ADRs 0025, 0064). A first pass, in a
  worker thread with its own heap, reads every worksheet in turn: its
  name, whether the workbook hides it, its header (the first row that
  holds something), how many rows and formulas it holds. The file is
  staged with what it found, for its uploader only, half an hour. A job
  then reads each chosen sheet again a batch at a time and writes its
  rows as it reads them, up to `IMPORT_MAX_ROWS` rows in all.
- **Field types from every row, not from a sample.** The first pass
  feeds every value of a sheet to its column's guess, which keeps only
  what each candidate type still needs (`FieldGuess`). A field is a
  number only if every value of its sheet is one, so no row of the new
  base is refused for a value a sample did not see. A short list of
  repeated values becomes a single select with those options.
- **The person chooses the sheets.** The shown ones are ticked, the
  hidden ones are not; the base takes the file's name, which they can
  change. Making it needs the right to make a base and a second factor,
  as any new base does.
- **The job makes the base or nothing.** A failure, or a cancel, removes
  the base begun. Its result says, for each sheet, the rows written and
  any left out, and how many formulas came as their values.

## Consequences

- Formulas come as the values the file kept. Formatting, charts,
  comments, merged cells, and the links between sheets do not come.
- A sheet past 200 columns, or a workbook with more sheets than a base
  takes tables (100), is refused.
- A blank header gets a name of its own, as the table import gives one.

## Rejected

- **Google's Sheets API.** It needs an API key the operator creates, and
  reads with it only sheets shared publicly; a private sheet needs an
  OAuth client the operator registers with Google, which reviews apps
  that read people's files. The instance would reach Google, which
  nothing else in it needs (ADR 0019).
- **A sheet's public export link.** It needs no key, but only for sheets
  shared with anyone who has the link, and it is not a documented API.
- **Types from the first rows**, as the table import's preview guesses
  them. The table import lets the person change each type before it
  writes; a base of many sheets would ask for every field of each.
