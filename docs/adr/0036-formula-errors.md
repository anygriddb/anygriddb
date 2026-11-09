# 0036 — Formula errors travel beside the value

- Status: Accepted
- Date: 2026-11-08

## Context

Formulas compile to SQL and run in the engine that holds the rows (ADR
0005). A spreadsheet formula can also produce an error: ERROR("message")
makes a cell show that error, the error passes to every formula that
reads the cell, and IS_ERROR catches it. People use this to check data:
`IF({Quantity} < 0, ERROR("negative quantity"), {Quantity} * {Price})`.

SQL has no error values. Raising an error fails the whole query, and so
the whole page. And a value column has one type: a number column cannot
also hold a message.

## Decision

- **An error's value is blank.** Filters, sorts, groups, footers, and
  exports read it as an empty cell.
- **Its message travels beside it.** For each formula field that can
  meet an error, the compiler writes a second SQL expression: the
  message, or null (`formulaError` in `expressions.ts`). That expression
  follows the formula:
  - ERROR gives its message, or an empty one.
  - An operation or a function passes on the first error among its
    arguments.
  - IF and SWITCH pass on the error of the branch they take.
  - A field that reads another formula field passes on that field's
    error.
  - IS_ERROR tests for an error and passes none on.
- **A page carries the messages in one object per row**, `ag_errors`:
  field name to message. Field names cannot start with `ag_`. The key is
  built only when a field read can meet ERROR, so other tables pay
  nothing. The client shows the cell in the danger colour with
  `#message`; a screen reader hears "error, message".
- **The same on every engine.** The expressions are made of CASE and
  COALESCE, which the four engines read alike. The conformance suite
  compares values and messages on all four.

## Consequences

- An error does not reach across a link: a lookup or a rollup reads only
  the values of the linked rows.
- Engine failures (a division by zero, a text that is not a date) stay
  blanks, as before. Only ERROR makes an error.
- Where a field cannot carry the extra expression, the row has none: an
  error there is just a blank.

## Rejected

- **Raising the engine's own error.** One bad row would fail the read
  for everyone.
- **A marker inside the value** (a text such as `#ERROR!`). It does not
  fit a number or a date column, and filters and sums would read it as
  data.
- **Computing errors in the application.** Filters, sorts, and groups
  run in the engine and would not see them (ADR 0005).
