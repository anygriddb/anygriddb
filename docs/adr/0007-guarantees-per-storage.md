# 0007 — What audit, locks, and signatures guarantee on native and external tables

- Status: Accepted
- Date: 2026-11-07

## Context

On native tables, PostgreSQL triggers enforce compliance: an append-only
audit trail, refusal to change locked or signed rows, and the status
workflow. On an external table, other applications write without
AnyGridDB, and no transaction spans AnyGridDB's database and the client's.

## Decision

| Guarantee                | Native table                 | External table                                                                                                                                            |
| ------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit trail              | Every write, in the database | Writes made through AnyGridDB, recorded in three steps (intent, applied, confirmed); a job settles what a crash left open by reading the row again        |
| Locked and signed rows   | Refused by the database      | Refused by AnyGridDB. A SHA-256 fingerprint of the signed values is checked on a schedule, so a change made elsewhere is **detected** and raises an alert |
| Row trash                | Full restore                 | Deletes off by default; a restore re-inserts the row from the audit trail, best effort                                                                    |
| Formulas, filters, sorts | Every function               | Every function the engine reproduces exactly (ADR 0005)                                                                                                   |

The documentation, and what AnyGridDB tells its users, must state this
difference plainly.

## Later option

An **audit kit**: triggers, one script per engine, that a DBA installs in
their own database so writes made outside AnyGridDB are audited too.

## Rejected

- **Distributed transactions (XA).** Fragile, and unevenly supported across
  engines and managed services.
