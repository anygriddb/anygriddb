# 0069 — The change trail kept for a time

- Status: Accepted
- Date: 2026-11-13

## Context

The change trail (`audit_events`) keeps every write to a row with its
values before and after, and every change to a base's structure and
roles. It is append-only: a trigger refuses every update and delete, but
the change of author when an account is erased. It is kept without
limit, so it only grows, and it holds personal data that some
organisations may not keep for ever.

The trail is also what the row trash restores a deleted row from, and
what a row's history is read from.

## Decision

- **For ever by default.** `auditRetentionDays` is 0 until an
  administrator chooses a time, in Administration's security policy.
- **A year at least, ten at most.** The trash keeps a deleted row a year
  at most and restores it from the trail: a shorter trail would empty
  the trash behind people's backs.
- **One purge a day, at night.** It deletes the events older than the
  time chosen, 5,000 at a time by the index on their date, for five
  minutes at most: a trail of years empties over several nights.
- **Only the purge deletes, and only from the trail.** The trigger lets
  a row of `audit_events` go when a flag local to the purge's
  transaction is set. Signatures and the trails of client tables are
  never deleted, flag or not, and every other write still finds the
  trail immutable.
- **The purge is on the trail**: one event a day when something went,
  with how many events and from before when, under the name of the
  administrator who chose the time. Administration's trail filters on
  it.

## Consequences

- A choice of a shorter time deletes, the next night, what is older, for
  good. The setting's own text says so.
- A row's history starts at the oldest event kept; a row deleted before
  that cannot be restored, and has left the trash by then.
- The change of the setting is on the sign-in trail, as every setting's.

## Rejected

- **A partition per month, dropped when it is past.** It is what a trail
  of hundreds of millions of events needs, and a rewrite of the table
  and of everything that writes to it. The delete by date is what an
  instance needs first; the partitions can follow under the same
  setting.
- **A purge every hour.** The trail would say so twenty-four times a
  day.
- **Less than a year.** The trash and a row's history would lose what
  they show.
