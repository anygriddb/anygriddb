# 0146 — A role given until a date

- Status: Accepted
- Date: 2026-11-28
- Relates to: 0077 (restore points), 0128 (who gives which role), 0131
  (attributions)

## Context

ADR 0131 gave every attribution an end (`ends_at`): past it, the role
gives nothing, and a nightly pass was to remove it, written to the trail
as ended rather than as taken away by someone. Nothing set an end: a
locum nurse for a month, an auditor for a week, a contractor until the
project closes, all kept their role until someone remembered to take it
away. Where AnyGridDB is meant to run, access is granted for a time and
reviewed, and an access nobody remembers is the one that leaks.

## Decision

1. **A role on a base or a table, a person's or a group's, may end** at a
   day the giver chooses: from the start of the day after, it gives
   nothing. It is set and changed from the base's settings, where the
   role is given, by whoever could give that role (ADR 0128), and taken
   away the same way: "No end".
2. **An owner's role does not end**: a base keeps an owner, and one that
   ends would leave it without one. An end in the past is refused.
3. **An ended role goes within the hour**: the hourly purge removes it,
   written to the change trail under whoever gave it, from the source
   `ended`, and open pages ask again what they may read.
4. **Its end is shown where the role is**: a base's members, a table's
   people and groups, the groups given a role on the base.
5. **Kept by restore points and copies**: a role keeps its end; one that
   has ended by the time it is given back is not given back.

## Not now

An end set from Administration's pages (an account's bases, a group's
roles), a notice to the person or the owners before it comes, and an
end on a role of Administration.

## Consequences

- Temporary access is given once, with its end, and ends on its own.
- The trail says a role ended, not that someone took it away.
