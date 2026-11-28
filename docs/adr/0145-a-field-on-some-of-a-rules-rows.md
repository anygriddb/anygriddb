# 0145 — A field on some of a rule's rows

- Status: Accepted
- Date: 2026-11-28
- Relates to: 0016 (field and row rules), 0131 (attributions), 0142 (a
  person's attributes in a rule), 0144 (a field's access holds on its
  attribution's rows)

## Context

A rule narrows a role on a table to some rows, and gives each field at
an access: hidden, read only, read and written. A ward's nurses who should
see every patient, to find a bed or a colleague's patient, and the
diagnosis of their own ward's alone, needed two roles: one on every row
without the diagnosis, one on their ward's rows with it. Since ADR 0144
two roles give each field on their own rows, so it held; but it took two
roles a nurse, or two groups and two rules a ward, kept in step by hand.

## Decision

1. **A field's entry in a rule may name rows of its own**: the field has
   its access on the rule's rows that match them, and is hidden on the
   others. Without them, it holds on every row of the rule, as before.
   A hidden field takes none.
2. **They are conditions as a row rule's are**: on the table's fields,
   kept only if they compile whole, and they may name the reader's
   attributes (ADR 0142), so one rule serves every ward.
3. **Read and written as ADR 0144 says**: a field is seen, and written,
   on the rows of the attributions that give it, each on the rows its
   own condition keeps. Everything that reads a field reads it there and
   empty elsewhere; a write elsewhere is refused.
4. **Kept with the rule**: in the field's entry, as its access and its
   rows. A version before this one reads such an entry as a hidden
   field: a step back narrows, never widens. Restore points and copies
   of a base keep it, as they keep the rule.

## Consequences

- "Diagnosis, read only, on the rows where Ward is the reader's Ward",
  given to the nurses' group on every row, is one rule for every ward.
- A field shown on some rows reads empty on the others, as ADR 0144 says.
