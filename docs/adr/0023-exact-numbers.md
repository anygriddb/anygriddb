# 0023 — Exact numbers: decimals and 64-bit integers travel as strings

- Status: Accepted
- Date: 2026-11-07

## Context

Native number fields are stored as `numeric`, which is exact. On the way to
and from the browser they become JavaScript numbers (IEEE 754 doubles):
`z.number()` in the value schemas, and `parseLooseNumber`
(`packages/core/src/cell-values.ts`) for typecast.

A double holds 15 to 17 significant digits and integers up to 2^53 exactly.
External sources (ADR 0006) break both limits routinely:

- an ERP amount in `DECIMAL(19,4)` loses its last decimals above about
  10^11;
- a `BIGINT` key above 2^53 is rounded, so
  `UPDATE … WHERE key = ?` updates another row or none.

For a product sold on its audit trail, either is a defect.

## Decision

- **On the wire and in the core**, an exact number (decimal, numeric, money,
  64-bit integer) is a canonical decimal string: optional `-`, digits, an
  optional `.` and digits, no exponent, no grouping.
- **Keys are strings.** Row keys of external tables are never converted to
  numbers.
- **Display** uses `Intl.NumberFormat`, which formats a decimal string
  exactly (ECMA-402 NumberFormat v3). No decimal library is needed while
  arithmetic stays in SQL.
- **Typecast** produces the canonical string, checked against the column's
  precision and scale when the source declares them.
- **Drivers return strings**:
  - `pg`: `numeric` and `int8` already arrive as strings.
  - `mysql2`: `supportBigNumbers: true`, `bigNumberStrings: true`;
    `DECIMAL` already arrives as a string.
  - `tedious`: if it returns `decimal`, `numeric`, or `money` as a JavaScript
    number (to confirm in phase 5), the SQL Server backend selects those
    columns cast to `varchar`.
- **Floating-point columns** (`float`, `real`, `double`) stay JavaScript
  numbers: they are not exact in the source either.
- **The conformance suite** (ADR 0005) includes values at the limits:
  2^53 + 1, `DECIMAL(38,10)`, and money.

## Consequences

- The number field's value schema, typecast, display, filters, and the REST
  API change from number to string for exact columns. The REST API documents
  the format.
- Charts convert to doubles for drawing only.

## Rejected

- **Doubles everywhere.** Silently wrong data.
- **`BigInt`.** It holds integers only, and JSON cannot carry it.
- **A decimal library in the browser** (decimal.js, big.js). Not needed
  while computation happens in SQL; it can come later if client-side
  arithmetic does.
