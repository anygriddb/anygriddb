# 0008 — graphile-worker for events and jobs

- Status: Accepted
- Date: 2026-11-07

## Context

Row writes publish events for webhooks, automations, and notifications.
`publishHook` (`apps/api/src/webhooks.ts`) pushes them to the Redis list
`ag:events`:

- the push happens outside the write's transaction, and its error is
  swallowed;
- the list is trimmed to 100,000 entries;
- `BLPOP` removes an event before it is handled.

If Redis is down, if the worker crashes, or if the list is full, a webhook
or an automation is lost without a trace. For a product that sells an audit
trail, that is a defect.

Jobs, schedules, retries, and purges each have their own homemade loop: a
lease in the `jobs` table, the `JOB_WAKE` list, `FOR UPDATE SKIP LOCKED`
claims, webhook retries after 1, 5, and 30 minutes, and a daily purge.

## Decision

[graphile-worker](https://worker.graphile.org) (MIT) runs every background
task in PostgreSQL:

- **Transactional enqueue.** An event is enqueued in the same transaction as
  the write, from the application or from the audit trigger
  (`graphile_worker.add_job`). An event exists if and only if the write
  committed.
- **Workers wake up through `LISTEN/NOTIFY`**, with no polling.
- **Retries, scheduling, and deduplication come built in**: retries with
  backoff, a crontab for schedules and purges, and job keys.
- **The product's `jobs` table stays** for what people see: progress,
  cancellation, and files to download. Its tasks run in graphile-worker.

## Consequences

- No event is lost or invented.
- Hundreds of lines of homemade queue code go away.
- The worker needs a direct connection (ADR 0003).

## Rejected

- **pg-boss.** A serious equivalent, but enqueueing from SQL in a trigger is
  more natural with graphile-worker.
- **BullMQ.** It needs Redis (ADR 0009).
