# 0087 — Recent lines of the process, in Administration

- Status: Accepted (extends 0018)
- Date: 2026-11-15
- Relates to: 0018 (logs on the process output), 0071 (an auditor reads)

## Context

The process writes structured JSON to its output. An operator who is not on
the machine that runs it had no way to read a warning or a failure. The
lines of the database and of the file store are a different process's
output. Reading those from the application would mean giving it the host's
power, which the containers are built to refuse.

## Decision

- **This process only.** Administration, under Instance, shows the recent
  lines of the process that serves the application. The database and the
  file store keep their own logs where they run. A collector pointed at
  the container's output is unchanged, and still has every line.
- **A copy in memory.** The logger writes its line twice: to the output,
  and into a ring that keeps at most 500 lines and 512 KiB. The ring is
  empty when the process starts. It is not written to the database: a
  burst of lines must not load it, and the page is this process's own.
- **What is kept.** Warnings, errors, and the messages the process writes
  about itself. A successful request is left on the output only, so the
  health probe does not push a failure out of the ring. A request that
  ended at 400 or above is kept.
- **What the page returns is stricter than the output.** A line keeps its
  time, its level, its message, an application code, the status, the
  request's method, path and address, and a failure's kind, code,
  constraint and frames. A browser failure keeps its kind, its path and
  its message. A path that holds a secret is masked, as it already is on
  the output. Any other field is dropped, including a failure's message,
  which quotes the value that failed.
- **Who reads.** An administrator, and an auditor, the same as Health. A
  support account, an API token and the administration API do not. It is
  a read: no proof, no export, and the support bundle does not carry it.

## Rejected

- **The other containers' logs, read from the host.** That is the
  container runtime's socket, or the host's log directory: the power of
  the host, inside the application. The containers drop every capability
  and run from a read-only image.
- **A table of lines.** The page would go quiet in the failure it exists
  to show, a database that no longer answers, and a flood of lines would
  be a flood of writes.
- **Every request.** The ring would be the access log, and the warning
  that matters would already have left it.

## Consequences

- Several API processes each show their own lines. One process is the
  supported shape.
- A line from before the last start is on the container's output, and on
  a collector, and not on the page.
- The pool's and the bus's failures, which are written beside the logger,
  are copied into the same ring.
