# 0115 — A burst of automation runs waits its turn

- Status: Accepted
- Date: 2026-11-22
- Amends: 0008 (events and automations run on the queue)

## Context

An automation may start 300 runs a minute. Past that, a run was logged as
skipped and did nothing, and no one was told: an import of a thousand rows
left seven hundred of them unprocessed. The count came from the run log,
which holds the skipped runs too, so a steady flow above five events a second
kept the limit shut and ran nothing past the first 300. It was read without a
lock, so two workers could pass it together.

## Decision

- **A run past the limit runs later.** Mails and calls included: the limit
  exists to spare what they reach, and the work was asked for.
- **Its place is taken once.** `automation_run_pace` keeps, per automation,
  the furthest minute given to a waiting run and how full it is. A run takes
  the next place in one statement and is queued for that minute, spread over
  it. A burst of 20,000 rows queues each of its runs one more time, not once
  a minute.
- **The limit holds on what starts.** A second count, of the runs that
  started this minute, is moved in one statement by every worker. A run that
  reaches its minute late and finds it full moves to the next one.
- **Nothing is done twice.** The place is taken before any action, and a run
  stays a job tried once.
- **A day at most.** A run that cannot be given a minute within 24 hours, or
  has waited that long, is logged as skipped and does nothing. Its author is
  told, once a day at most, and `anygriddb_automation_runs_paced_total` counts
  the runs delayed and dropped.
- **A button is answered at once.** Someone is waiting for it: past the limit
  it says so, as it did. A schedule that finds its minute full waits like any
  other run.

## Rejected

- **Dropping and telling.** The work would still not be done.
- **Trying again each minute without a count.** A burst of 20,000 rows would
  queue hundreds of thousands of jobs.
- **No limit.** A loop would take the workers, the mail relay and the
  addresses it calls with it.
