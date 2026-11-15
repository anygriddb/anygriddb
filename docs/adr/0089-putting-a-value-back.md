# 0089 — Putting a value back writes a new change

- Status: Accepted
- Date: 2026-11-15
- Relates to: 0007 (what the trail guarantees), 0028 (a client's write
  compared with what was seen), 0049 (rows have no version number),
  0069 (the trail kept for a time), 0077 (a restore point is a new base)

## Context

Every change of a row, and of the objects people set up around it, is
already kept: the row before and after, and the catalog row before and
after. The history of a row shows that, and stops. A mistake made
yesterday, or by someone else, stays until it is typed again. A restore
point is a copy of a whole base, kept beside it for a risky change. The
trash brings back what was deleted. Neither is a previous value of
something that is still there.

## Decision

- **A version is a change the trail already kept.** Nothing is copied
  into a second store. Putting a value back writes forward, through the
  writer that already changes that object, as a new change whose source
  is `revert`. The trail stays append-only. The person who puts it back
  is its author.
- **The server reads the earlier value from the event.** The request
  names the event and sends what is on the screen now. The event has to
  belong to that object. When what is stored is no longer what was sent,
  nothing is written.
- **What can be put back is content a person can write again, on an
  object that is still there.** A field or the row, on AnyGridDB's own
  tables and for a write AnyGridDB made on a client's table. The name
  and description of a base, a table, and a dashboard. A field's label
  and settings while its type is still the one in the event. A shared
  view's name and configuration while its type is still that. A folder's
  name. A widget's title, kind, and configuration, where it sits now. An
  automation's name, activation, trigger, and actions. What a webhook
  was set to, apart from its secret. A formula, a lookup, and a rollup
  are computed again. A many-to-many link stays as it is.
- **What is not put back.** A role, a rule, a group, or an invitation:
  the trail keeps them to be read, and giving one back opens access. A
  token, a link's password, a source's secret, a webhook's secret: the
  trail does not hold them. A sign-in, a run, a delivery, a task, a
  notification. What only arranges a screen. A comment. An account that
  was erased, and the trail itself. An object that was deleted and is
  not in the trash. A field from before its type changed. A file the
  store no longer has. A value a client's database wrote outside
  AnyGridDB.
- **How long.** As long as the trail keeps the event. The screen shows
  the latest 200 events of the object.

## Consequences

- A locked or signed row refuses this as it refuses an edit. A field
  that asks for a reason asks for one here too.
- A client's row is compared the way its other writes are. A value
  written in the client's database, outside AnyGridDB, is not here.
- Putting a widget back does not move it. The trail does not record
  where a widget sits.
- The address of a webhook comes back without the query the trail never
  stored.

## Rejected

- **A second table of versions.** It would drift from the trail, which
  already holds the before and after.
- **Rewriting the trail so the later change disappears.** Signatures and
  the trail's own rule depend on it only growing.
- **Putting a whole base back in place.** The rows written since the
  point would be lost (ADR 0077). A point stays a new base beside the
  old one.
- **The same button on access and on secrets.** One click would reopen
  an access or invent a secret the trail does not have.
