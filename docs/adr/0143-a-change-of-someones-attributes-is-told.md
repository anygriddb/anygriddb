# 0143 — A change of someone's attributes is told

- Status: Accepted
- Date: 2026-11-28
- Amends: 0142 (a person's attributes in a rule)
- Relates to: 0074 (an administrator's way into a base), 0128 (who gives
  which role)

## Context

ADR 0142 lets a row rule name an attribute of the reader: "Ward is the
reader's Ward". A person's values then decide which rows they read, as a
role does. A role given by an administrator is told to the base's owners
(ROADMAP #91), and one an administrator gives themselves asks a reason
first (ADR 0074). A change of values was told to no one: an administrator
could add every ward to their own account, or to a nurse's, and read or
let read every ward's rows of a base whose owners learn nothing. The
change trail held it, and only someone reading the trail would see it.

## Decision

1. **A change of someone's values is told** to the owners of each base
   where a row rule naming one of the attributes changed reaches them, by
   a role on a table of their own or of one of their groups: in the app,
   as a role given is, with who changed what. Values set to what they
   already were tell nothing; the identity provider's, at provisioning,
   are its own and tell nothing either.
2. **An administrator's own values ask a reason**, as a role they give
   themselves does, and the owners read it in the notice. The reason is on
   the change trail with the values.

## Consequences

- An administrator who is also a nurse sets their own ward as they give
  themselves a role: in the open, with a reason.
- A base's owners learn of every change in who reads which of its rows,
  whether it comes as a role or as a value a rule reads.
