# 0057 — Administration decides who sees which base

- Status: Accepted
- Date: 2026-11-11
- Supersedes: in ADR 0042, the rejection of "an administrator's invitation
  into any base"

## Context

ADR 0042 kept inviting into a base as its owners' decision: an
administrator could withdraw a pending invitation, never send one, so
that being an administrator would not give anyone a base's data. The
instance's owner now wants the administrator to choose who sees what,
with which role, on which base, from Administration: an organisation
brings people in and gives them their workspaces in one place, and does
not want to chase each base's owner to do it.

## Decision

- **An administrator gives roles on any live base.** First when adding a
  person (`admin.createAccount`, up to 20 bases), then from the account's
  page and from a base's page (ROADMAP #68, #69). A base in the trash is
  refused, and nothing of the account is made.
- **Every grant is on the change trail** under the administrator's name,
  through the same path an owner's grant takes (`bindRole` inside the
  audited transaction); the account's creation is on the sign-in trail
  (`account_created`, with `as_admin` when it administers the instance).
- **The invitation domains still hold** (ADR 0044): a role on a base goes
  only to an address invitations may reach. The sign-up mode and domains do
  not apply to the account itself: the administrator chose this address.
- **An administrator sends a pending invitation again**, by mail, or hands
  its new link over when the instance sends no email.

## Rejected

- **Only the bases the administrator already owns.** It keeps the old
  promise, but the administrator then cannot do the job the owner asked
  for, and would add themselves as owner first, which hides what happened.

## Consequences

- An administrator can reach any base's content: by giving a role to an
  account they hold. Base owners count on the trail, not on a wall: each
  grant names its author. Opening a base without a role, and the reason an
  administrator gives for a role of their own, are ADR 0074.
- An account an administrator creates has no password until its first
  link sets one (a week); an account that signs in through its identity
  provider gets no link.
