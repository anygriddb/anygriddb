# 0144 — A field's access holds on its attribution's rows

- Status: Accepted
- Date: 2026-11-28
- Amends: 0131 (attributions, by union)
- Relates to: 0016 (field and row rules), 0142 (a person's attributes in a
  rule)

## Context

ADR 0131 adds up what every attribution that reaches someone on a table
gives. Rows were combined attribution by attribution: a rule narrows only
the attribution it comes with. Fields were combined apart, by the widest
access any attribution gives, whatever rows it reaches. Together, two
narrow attributions gave more than either: a nurse who reads her ward's
rows whole, and every ward's rows without the diagnosis (to count beds),
read the diagnosis of every ward. Writing was the same: a field one
attribution lets someone write on their own rows was written on every row
another attribution let them change.

## Decision

1. **A field is seen on the rows of the attributions that show it**, and
   written on the rows of those that let it be written; never on a row
   that only another attribution reaches. What someone may do on a table
   is the union of what each attribution gives on its own rows.
2. **Where the read engine compiles a field** (the page, a row, formulas,
   lookups and rollups from other tables, filters, sorts, searches, groups,
   counts and exports), a field shown on some rows only reads its value on
   those and empty on the others, so nothing that reads it can find what
   it hides. Its past is left out of the history of a row it is hidden on.
3. **A write of a field** is refused on a row where no attribution that
   lets it be written reaches, before the write and once it is done, as a
   row's rule is (ADR 0112).
4. A field's access, the widest any attribution gives, still says what
   someone may do with it somewhere: the field is listed, and offered for
   editing, as before.

## Consequences

- **Someone with several attributions on a table may see or write a field
  on fewer rows than before**: on exactly those its rules give it on.
  Nobody sees more.
- A field hidden on a row reads as empty there, as a field hidden whole
  does: the page does not yet tell an empty value from a hidden one.
- Reading a field shown on some rows only costs one more condition per
  such field in the query that reads them.
