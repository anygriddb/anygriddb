# 0138 — The SQL of each field type in one entry

- Status: Accepted
- Date: 2026-11-26
- Relates to: 0006 (client tables), 0028 (writes to a client's table),
  0032 (side tables), 0118 (seal formats)

## Context

What a field type is (its storage role, its kind, what it may be) has one
definition per type, which the compiler refuses to leave out. What its SQL
does did not: the read compiled a field through a `switch` on its type
whose last branch took any other, the write to a client's column did the
same, and some forty tests by name across the read, the five dialects, the
copies and the conversions said how one type reads (a document as its
text, a date on Oracle as its day, a date and time in UTC, a checkbox kept
as a number). The side table's columns were a second list beside the
definitions, held to it by a test. A new type fell into every last branch
without a word, and nothing said where it was read differently.

## Decision

- **One entry per type, per engine where it differs**
  (`packages/core/src/query/field-sql.ts`, `FIELD_SQL`, `satisfies
Record<FieldType, …>`): how a read compiles it (its column, its
  expression, a lookup, a rollup, its links, the row's id, nothing), what
  its column holds (a text, a document, an exact number, a flag, a day, an
  instant, a link's key), whether AnyGridDB writes it to a client's
  column, where its choices come from (its options, its table's states),
  and the column a side table gives it on each engine.
- **The queries read the entry**: the read's and the write's `switch` turn
  on the entry's rule, every case named, and the dialects ask what a column
  holds, never which type it is. A formula's expression and a rollup's
  function are read through the entry too.
- **The field dialog's settings and what it still needs** are a record per
  type as well, which the compiler holds complete.
- **A check refuses a type tested by its name** in the queries
  (`scripts/type-tests.mjs`, in the conventions check), but in their
  registry. An import's table of another product's types stays: it
  translates their types, not ours.

## Consequences

- A new type is refused by the compiler until it says how it reads, what
  its column holds, whether it goes to a client, and its side column.
- The SQL each type gives on each engine is unchanged, byte for byte: the
  three freezes of the per-type SQL hold it.
- A rating or a duration on a client's float column reads as a number does:
  a float's infinities read empty, said beside the value, where the page
  stopped on PostgreSQL 13. A text-like field on MySQL's JSON or long text
  reads as its text, as a text did.
