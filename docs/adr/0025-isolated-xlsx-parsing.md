# 0025 — XLSX files are parsed in an isolated worker

- Status: Accepted
- Date: 2026-11-07
- Amends: the exceljs row of [0020](0020-kept-as-is.md)

## Context

Imports parse files uploaded by users, so the input is untrusted. exceljs,
the XLSX library (ADR 0020), has had no upstream release since 2023.
Several forks exist, each maintained by one company for its own needs.

An XLSX file is a zip archive of XML parts. A small upload can expand to
gigabytes (a zip bomb) or hold XML that takes a long time to parse.

## Decision

- **Parsing runs in a `worker_thread`**, started by the import job, with:
  - `resourceLimits` on its heap;
  - a time limit, after which the job terminates the worker and fails;
  - a cap on each zip entry's uncompressed size and on the total, checked
    from the archive's directory before anything is inflated.
- **exceljs stays**, behind the existing import and export interface.
- **Before phase 1 moves imports onto graphile-worker**, maintained forks
  and alternatives are evaluated:
  - license (OSI only);
  - a streaming reader;
  - known vulnerabilities;
  - who maintains it.
- **A switch** only changes the code behind the interface.
- SheetJS stays excluded (ADR 0020 rule files).

## Consequences

- A hostile or broken file costs one failed job, not the API process.
- Exports keep using exceljs in the job. Writing is lower risk than parsing
  untrusted input.

## Rejected

- **Parsing in the request.** It blocks the event loop and has no limits.
- **Switching library now without evaluation.** No candidate has proven
  better maintenance yet.

## Evaluation (2026-11-07)

Done before imports moved onto graphile-worker, as decided above.

| Candidate                | Finding                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| exceljs 4.4.0            | MIT, streaming reader. No release since 2023                                                                                                                            |
| `@protobi/exceljs`       | A temporary fork waiting for upstream merges, kept by one company                                                                                                       |
| `@ayocore/exceljs` 5.0.4 | A hardened, Node-only fork kept by one person                                                                                                                           |
| `read-excel-file` 9.3.14 | MIT and maintained, but it reads the whole file at once, and its zip and worker dependencies (`unzipper-esm`, `worker-f`) were created in 2026 by its single maintainer |
| `excelts`                | Not published on npm                                                                                                                                                    |

**Outcome:** exceljs stays, now parsed in the isolated worker. None of the
candidates is better maintained without a new supply-chain risk. The
question comes back when upstream releases again or a fork gains a team.
