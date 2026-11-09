# 0027 — An engine's limits are shown, not refused

- Status: Accepted
- Date: 2026-11-07

## Context

ADR 0005 made a function a backend cannot reproduce exactly
**unavailable** on that source, so that a result is never silently
different. In practice that refused:

- SQRT, EXP, LN, LOG, and POWER on MySQL and MariaDB, which compute them
  in floating point only;
- every formula, lookup, and rollup on SQL Server, whose decimals stop at
  38 digits and lose scale silently past them.

The client chose their engine and knows it. Refusing hides what their own
database computes every day, and leaves the person with no way forward.
They would rather build the field and be told, plainly, what their engine
does differently.

## Decision

- **Where an engine computes a function differently, AnyGridDB runs it
  the engine's way and records a limit on the field.** Two limits:
  - `approximate`: the engine computes in floating point (SQRT, EXP, LN,
    LOG, POWER on MySQL, MariaDB, and SQL Server). The result is rounded
    to 15 significant digits, what a double holds reliably, and turned
    back into an exact decimal, so what follows computes exactly again.
  - `precision`: the engine keeps at most 38 digits in a number (SQL
    Server's decimals). A product, a quotient, or a mean may be rounded.
- **The compiler finds the limits** of each field as it compiles it,
  those of the fields it reads included, and the catalog returns them
  with the field (`packages/core/src/query/limits.ts`).
- **The person sees them**:
  - a mark in the column header, with the sentence on hover and for a
    screen reader;
  - in the formula editor, a warning under the function or operator as it
    is typed, and the sentences under the editor;
  - in the lookup and rollup form, for the field read and the rollup's
    own computation.
- **The sentence is short and names the engine**: what it does, and that
  it is the engine's limit. For example: "MySQL calcule SQRT de façon
  approchée : le résultat est juste à 15 chiffres près. C'est une limite
  de MySQL."
- **What no engine function can produce is still refused**
  (`function_unavailable`), until AnyGridDB writes it with what the
  engine has.
- **The conformance suite** holds both sides: an exact result must read
  the same as on PostgreSQL, an approximate one must agree to a double's
  digits and carry its limit, and a field without a limit must carry
  none.

## Consequences

- ADR 0005's promise becomes: a result is never _silently_ different.
- Formulas, lookups, and rollups can run on SQL Server. The compiler
  follows each number's T-SQL type (`digits.ts`) so that the `precision`
  limit marks only the operations whose declared types can lose digits;
  the formula editor, which knows no types, marks only `approximate`.
- A compiled formula has a size bound (`formula_too_large`): a guarded
  function repeats its argument, so nested calls grow geometrically.

## Rejected

- **Refusing (ADR 0005's rule).** It blocks the person for a difference
  that rarely shows at the precision a field displays.
- **A confirmation when the field is saved.** It interrupts once and is
  forgotten; a mark on the field stays where the values are read.
- **Computing these functions in the application.** Filters, sorts,
  groups, and aggregates would then not see them (ADR 0005).
