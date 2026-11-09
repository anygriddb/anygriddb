# 0037 — Airtable bases imported through Airtable's Web API

- Status: Accepted
- Date: 2026-11-08

## Context

People moving from Airtable want their base: tables, field types, links,
views, and rows. CSV exports lose links, and must be done table by table.
Importing means reading Airtable, which AnyGridDB never reaches otherwise
(ADR 0019: no outside service at run time).

## Decision

- **Airtable's documented Web API, with a personal access token** the
  person creates with `schema.bases:read` and `data.records:read`. The
  import reads the schema, then every table's records, five requests a
  second at most and waiting when Airtable asks, over HTTPS to
  `api.airtable.com`, its certificate verified.
- **A background job the person starts and follows.** The token goes
  into the job sealed with the instance's key (AES-256-GCM), is never
  returned or logged, and leaves the job's input when the job ends,
  however it ends, or when a queued job is cancelled.
- **Converted to a snapshot, built by the snapshot import.** One pure
  function (`airtableToSnapshot` in core) maps Airtable to AnyGridDB.
  The base is then built by the code that imports `.anygriddb.json`
  files, which validates and cleans up a half-built base.
  - Field types map to their equivalents.
  - Two linked fields become one two-way link.
  - Lookups and counts stay computed. A formula stays a formula when it
    parses and reads plain fields of its table.
- **A report names what did not come over as it was**:
  - rollups (the API does not give their calculation), formulas that do
    not convert, lookups through a one-way link: their values;
  - attachments: their file names;
  - people: their names and addresses;
  - views: no filters, sorts, or hidden fields, which the API does not
    give; a view of a type without an equivalent is left out;
  - buttons: left out.
- **The job's result carries the report**, and the jobs menu shows it.

## Consequences

- An offline instance cannot import from Airtable. The job says so, and
  nothing else depends on the internet.
- Attachments are not copied. Their URLs expire within hours, and
  copying them would need a download per file; a later version could do
  it.
- Airtable's created and modified times, and its auto-numbers, come as
  plain values: AnyGridDB's own would be those of the import.

## Rejected

- **A publicly shared base link**, read through Airtable's undocumented
  endpoints. It needs no token, but breaks when Airtable changes its
  pages, and reads only what a share shows.
- **CSV files, one per table.** They lose links, lookups, and field
  types.
- **Keeping the token**, for later imports. A secret kept is a secret to
  protect; the person can create another.
