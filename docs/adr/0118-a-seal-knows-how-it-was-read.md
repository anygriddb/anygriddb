# 0118 — A seal knows how it was read

- Status: Accepted (amends 0033)
- Date: 2026-11-23

## Context

A client's column was sometimes read through a conversion that lost what it
held. SQL Server's `money` came back with two decimals, floats with ten, a
PostgreSQL `real` with six digits. MySQL wrote a `TIME` wrong from 32 hours on,
and binaries as its own internal text. A rowversion or a blob holding a nul byte
could not be sealed at all. A flag holding anything but 0 or 1 read differently
in the grid and in its filters. The cell looked right and was not.

Reading these columns exactly changes what a read returns, and a lock keeps
what a read returned: every row sealed before would look changed the day the
reading improved. A seal cannot be rewritten to hide that either: it is a
record of what was seen.

## Decision

- **A seal has a format.** `external_statuses.seal_format` says which reading
  made it: 1 for what was sealed before this record, 2 from now on. The
  fingerprint's prefix carries the format too.
- **A row is compared by the reading of its seal.** Each dialect keeps the
  first reading (`firstSeal`). A row sealed in format 1 is compared under it.
  If it still holds what was sealed, it is sealed again in format 2, and the
  trail gets a `resealed` entry with the new fingerprint and the one it
  replaces. Signatures, and every earlier entry, stay as they are.
- **A renewal believes only what is stable.** The row is read in the new
  format before and after the comparison, and the two must agree. On a synced
  table, the copy must hold the new reading too, or the next check would see a
  change that is only the refresh. A row of a store whose values a double
  could have rounded keeps format 1 and its comparison.
- **A number reads as it is stored.** `money` by its own scale. A float by the
  shortest decimal that is that very value, written by the application from
  all the digits the engine gives. A filter and a sort compare the stored
  float, so that a value a cell shows is the value they find.
- **What a field cannot hold is said, in the cell.** A float past 1e28 or under
  1e-30, PostgreSQL's infinities and NaN, and an Oracle flag holding another
  code read empty with an error, and are sealed by what they say.
- **Text and bytes are text.** MySQL's `TIME` as its text, binaries as `0x` and
  their first thousand bytes in hexadecimal, a rowversion through `binary(8)`.
  A sealed text holding a nul is kept as its bytes, which no other text can be.
- **A write a code page alters is refused.** The row is read back in the write's
  transaction. A text that came back with characters replaced undoes the write
  and names the field. A value a trigger changed is the client's own rule, and
  is left alone.
- **An Oracle `NUMBER(1)` is a flag only when a check says so.** Without a check
  to 0 and 1 it is a number when it is exposed. A field already exposed keeps
  its type.
- **The row's own marks leave the fields' names.** `signature` and `drift` are
  now `ag_signature` and `ag_drift`: a client's column may be named either.

## Consequences

- An instance upgraded with sealed rows raises no alert for them. They are
  renewed by the next scheduled check, and each renewal is one entry in their
  trail.
- A value that changed below what the old reading could see, before the
  upgrade, cannot be told from one that did not: format 1 could not see it.
- Reading a float costs a second output column. Sums and groups still work on
  `decimal(38,10)`, as a field's limit says.

## Rejected

- **Encoding only at seal time.** The grid would go on showing raw bytes.
- **Reading a flag as `<> 0` on Oracle.** Unticking and ticking a code 5 again
  would write 1 and destroy it.
