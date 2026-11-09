# 0021 — TypeScript end to end, argued from what is actually shared

- Status: Accepted
- Date: 2026-11-07
- Supersedes: [0001](0001-typescript-end-to-end.md)

## Context

ADR 0001 kept TypeScript because the domain core "powers the formula
editor, completion, and error messages" in the browser. A second review
measured what `apps/web` really imports from `@anygriddb/core` (20 files):

- `coerceCellValue`: typecast for paste, forms, and public forms;
- `cellText`: how a value is displayed;
- filter types and `filterOperatorsFor`;
- function name lists (`FORMULA_FNS`, `ROLLUP_FNS`);
- `parseDelimited`, `renderTemplate`, `applyViewConfigPatch`, mentions.

The formula parser is not among them. The formula editor is a `<textarea>`
with insert buttons; formulas are parsed and typed on the server only.

Since ADR 0002, the product's center is the data plane: live reads and
writes on PostgreSQL, MySQL, MariaDB, SQL Server, and later Oracle. That is
where Python's SQLAlchemy is the strongest tool there is: first-party
dialects including Oracle, reflection (`Inspector`), type normalization,
`RETURNING` emulated as `OUTPUT` on SQL Server, and, since 2.1, Microsoft's
`mssql-python` driver built in. ADR 0004 rejected it in one line, by
reference to ADR 0001. This record weighs it on its merits.

## Decision

- Server, client, and shared core stay in TypeScript.
- **The formula editor becomes CodeMirror 6** (MIT), wired to `parseFormula`
  and a type checker in `packages/core`: highlighting, completion of fields
  and functions, inline errors, and functions a source cannot run (ADR 0005)
  marked as unavailable. The parser then really runs in both places.
- **Typing leaves the SQL compiler.** Today `query/expressions.ts` infers a
  result kind while it emits PostgreSQL. The intermediate representation of
  ADR 0005 types an expression first, with no dialect, so the browser can run
  the same checker.

## Why, compared with Python and SQLAlchemy

| Work                                                        | TypeScript                                              | Python with SQLAlchemy                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formula and filter semantics per dialect (the largest part) | Ours                                                    | Ours too. SQLAlchemy's generic functions are not exact: `func.char_length` renders `LEN` on SQL Server, which ignores trailing spaces. The conformance suite would override them |
| Introspection, type mapping, Oracle                         | About 5,000 lines, written once, tested on real engines | Provided                                                                                                                                                                         |
| Typecast, display, filter operators, function signatures    | One implementation                                      | Two, forever. Display must stay in TypeScript (`Intl`, rendering). A value displayed by TypeScript must parse back identically in Python: the class of drift ADR 0016 just fixed |
| SQL Server driver                                           | `tedious`: pure JavaScript, MIT, no Kerberos (ADR 0024) | `mssql-python` or `pyodbc`: native binaries whose license must be checked against the open source policy                                                                         |
| XLSX                                                        | exceljs, not maintained (ADR 0025)                      | openpyxl and calamine, maintained                                                                                                                                                |
| Realtime, jobs                                              | Event loop, `@fastify/websocket`, graphile-worker       | asyncio; SQLAlchemy's async layer runs sync drivers such as SQL Server's in a thread pool                                                                                        |

TypeScript costs a bounded amount once. Python costs a duplicate core for
the life of the product. We take the bounded cost.

## Consequences we accept

- We write schema introspection per engine ourselves. MikroORM 7's
  per-dialect introspection (MIT, built on Kysely, Oracle included) is the
  reference to read first.
- Exact numbers need care that Python's `Decimal` would give for free
  (ADR 0023).
- SQL Server Kerberos and an Oracle dialect for Kysely are gaps we close
  ourselves (ADR 0024).
- Heavy parsing (a 100,000-row XLSX) runs in jobs or worker threads, never
  in a request (ADR 0025).

## Escape hatch

If clients one day need a long tail of engines (DB2, Sybase, Informix) or
Kerberos everywhere, a connector process on the JVM, where JDBC is the best
connectivity there is, can sit behind the connector interface of ADR 0006.
That adds a process; it does not rewrite the product.

## Rejected

- **Python with SQLAlchemy.** The best dynamic SQL toolkit, and the only
  serious rival. Rejected for the permanent split of the core, measured
  above.
- **JVM (Kotlin) with JDBC.** The best drivers and uniform metadata, but the
  same split, and a heavy runtime for a small self-hosted server.
- **Go, .NET.** Very good drivers, including SQL Server Kerberos. The same
  split; Go is also awkward for writing a compiler.
- **Rust.** Weak SQL Server and Oracle support, slower iteration.
- **Bun, Deno.** Weaker compatibility with native modules (sharp, argon2).
- **Monaco** for the formula editor. Heavier, and less accessible than
  CodeMirror 6.
