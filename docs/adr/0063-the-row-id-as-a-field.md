# 0063 — The row's id as a field

- Status: Accepted
- Date: 2026-11-13

## Context

People ask for a UUID column: something stable to read, copy, and paste
into another tool, a URL, or a request to the API. Every row already has
one. A row of AnyGridDB's own tables has a UUIDv7 `id`, given when the row
is written and never changed; a row of a client's table has its key. That
id is what the REST API, the MCP server, webhooks, automations, links, and
the formula `RECORD_ID()` name the row by. It was shown nowhere in the
grid.

The other way was a second UUID, stored in its own column and filled for
every row. It would be a second identity that nothing else uses: the API
would still name the row by `id`, every existing row would need one
written when the field is added, and each copy, snapshot, and import
would need a rule for whether it keeps or remakes it.

## Decision

- **A field type, `row_id` ("Row id"), shows the row's own id.** It stores
  nothing: it reads `id` on AnyGridDB's tables and the key, as text, on a
  client's (the same text `RECORD_ID()` gives). It can be added to either.
- **It is read like text and never written.** It is filtered, sorted,
  searched, grouped, exported, and read by formulas and lookups like a text
  field. A write that names it is refused like a write to any system field.
- **A new row is a new id.** A table copied, a base snapshot imported, or
  a file imported makes new rows, so the field shows their new ids. An id
  that must travel from one copy to the next is data: it goes in a text
  field.

## Consequences

- What someone copies from the grid is what the API takes: no second
  identity, nothing written when the field is added.
- Filtering by the field compares text: on a very large table, finding a
  row by its id this way does not use the primary key's index. The API's
  own row routes still do.
