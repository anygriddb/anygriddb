# 0074 — An administrator's way into a base is told to its owners

- Status: Accepted
- Date: 2026-11-14
- Relates to: 0057 (an administrator gives roles on any base)

## Context

Administration shows what a base is made of (its members, its tables,
what leaves it) and never its rows. An administrator who had to read
them had one way: give themselves a role on the base (ADR 0057). That
is on the change trail, and nobody was told: a base's owners learned of
it by reading their member list. An incident, a blocked closing, a base
whose owners cannot be reached all call for an administrator to look,
and none of them should happen behind the owners' back.

## Decision

- **An administrator opens a base they hold no role on, to read it, for
  an hour**, from the base's page in Administration, with a reason. For
  that hour their own session has a viewer's role on the base: every
  table is read, nothing is changed, commented, or managed.
- **Their own session, and what they ask from it.** The opening follows
  their pages, their socket, and the jobs they start (an export, which
  is written to the change trail as anyone's). It does not follow an API
  token, an automation, a webhook, a calendar feed, or a public link:
  those keep to the roles the account really holds.
- **It ends** with its hour, when the administrator closes it, and the
  moment they are no longer an enabled administrator. Asking again
  starts the hour again.
- **The other way in asks the same.** An administrator who gives
  themselves a role on a base gives a reason too.
- **The owners are told at once**, in both cases: in the app, and by
  mail whatever they chose for notifications, since it is about who
  reads their data. The notice names the administrator, the base, the
  reason, and either the end of the hour or the role. While a base is
  open, those who manage it see who reads it, and why, above its
  members.
- **On the change trail** (`access`): who opened which base, why, until
  when. Never a value. The role an administrator gives themselves is on
  it as any role is, with its reason.
- **It asks for the proof**, as every change made in Administration
  does (ADR 0073). Closing one's own opening asks nothing.

## Rejected

- **Reading as an owner or an editor.** Looking is not taking over: the
  role with a reason is there for that, and says so to the owners.
- **An opening the owners must approve.** The cases it is for are the
  ones where they cannot be reached in time.
- **No export during the hour.** Reading is having: a file taken out is
  traced under the administrator's name, which a copy made by hand is
  not.
- **A notice left to each owner's choice of mail.** That choice is about
  mentions and replies.

## Consequences

- A base's owners count on being told, not on a wall: an administrator
  of the instance can read any base, and now never without a word.
- Roles an administrator gives to someone else, or through a group,
  are told to the owners in the app (ROADMAP #91): who received which
  role, and from whom. They ask no reason and send no mail: an
  administrator decides who sees which base (ADR 0057), and an
  administrator who joins a group that holds a role is named in the
  notice as anyone is.
- `rows.export`, a read that returned a table's rows as a file and
  wrote nothing to the trail, is removed: the app never called it, and
  the export that is traced runs as a job.
