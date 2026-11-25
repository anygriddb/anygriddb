# 0128 — Roles an administrator makes of a base's permissions

- Status: Accepted
- Date: 2026-11-25
- Relates to: 0057 (who grants on a base), 0070 (groups), 0127 (permissions
  of a base)

## Context

ADR 0127 named the act of every check and made the four roles packs of
those permissions. An organisation still could not give someone the right
to edit rows without the right to export them, or to give access without
running the base: the four packs were the only ones (ROADMAP #111).

## Decision

- **A made role** is a name and a set of the catalogue's permissions,
  `rows.read` always among them. An administrator makes, changes and
  deletes them in Administration, Roles (`admin.roles.*`, `made_roles`,
  migration 0138). The four stay as they are, shown beside them, and keep
  their names: no made role takes one.
- **It is given as the four are**: to a person on a base or a table, to a
  group on a base, by invitation, and by an administrator from an account,
  a base or a group. What is kept is one of the four (`role`) or a made
  role (`made_role_id`), never both.
- **What applies on one base or one table** is every role bound there,
  each giving what it gives: with the four alone, the highest, as before; a
  made role adds its permissions, and an owner holds them all. A table's
  role still replaces the base's, so a made role on a table lowers or
  raises access there exactly.
- **Nobody gives more than they hold.** Whoever holds `members.manage`
  gives a role only if they hold every permission it gives, the owner's
  only if they are an owner, and changes or takes away only a role they
  could give (`role_beyond_reach`).
- **A change is everyone's at once.** Changing a role's permissions
  changes the access of everyone who holds it; open sockets ask again. A
  role somebody holds, or that a waiting invitation names, cannot be
  deleted (`role_in_use`).
- **What else reads a role:** a read-only API token keeps a viewer's part
  of a made role and no more; the second factor the policy asks of owners
  is asked of whoever a made role lets give access or run the base; a
  status circuit's step given to one of the four is open to a made role
  by the act that rank stands for (editors: writing rows, owners: locking
  them).
- **A base's snapshot** carries a made role by its name and permissions.
  The import gives it back as the role of that name with exactly those
  permissions where it lands; a person whose role, on the base or one of
  its tables, finds none there is given nothing of the new base, and the
  report counts them: nobody sees more of the copy than of the base.

## Consequences

- Fine-grained access needs no new check: every guard already asks
  `roleGrants`, which reads a made role as it reads the four.
- A permission added later is in no made role until an administrator adds
  it; the four's packs say whether they hold it.
- Rights at a past date name a made role by its name now: its permissions
  then are not kept.
