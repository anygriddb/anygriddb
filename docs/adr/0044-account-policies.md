# 0044 — Who creates, whom owners invite, idle accounts, and lock alerts

- Status: Accepted (extends 0043)
- Date: 2026-11-09

## Context

ADR 0043 gave administrators a security policy from simple defaults.
Organizations asked for four more rules of the same kind: keep guests
out, keep base and token creation to administrators, retire accounts
nobody uses, and hear of a lock without reading the trail.

## Decision

The same pattern: an instance setting, a default that keeps today's
behaviour, and Administration > Security to change it.

| Setting                       | Default     | Choices                            |
| ----------------------------- | ----------- | ---------------------------------- |
| Whom owners can invite        | any address | only the sign-up domains'          |
| Who can create bases          | everyone    | only administrators                |
| Who can create API tokens     | everyone    | only administrators                |
| Disable accounts nobody uses  | never       | after 30, 60, 90, 180, or 365 days |
| Tell administrators of a lock | yes         | no                                 |

- **Invitations kept to the domains** hold for a new invitation, for
  adding an existing account to a base, for an invitation sent before
  (it no longer opens, nor lets its address sign up), and they reuse the
  sign-up domains: one list of the organization's domains. With none set,
  any address can still be invited.
- **Creation kept to administrators**: base creation is checked where
  every creating path already passes (`authorize(ctx, true)`: new base,
  template, snapshot, copy, Airtable import). Bases already made stay
  with their owners. While API tokens are kept to administrators, the
  others' tokens stop working, and work again if the setting comes back,
  as 0043 does for shorter lifetimes.
- **Idle accounts**: `users.active_at` moves at each sign-in, each token
  use (at most once a minute), and when an administrator enables the
  account again. The hourly purge disables accounts past the delay, with
  `disabled_reason = 'inactive'`, ends their sessions, keeps the event in
  the trail, and mails the person. With email set up, each person is
  warned once, a week before (a quarter of the delay when shorter), and
  disabled only after that week: turning the policy on never disables
  anyone without notice. Administrators, and accounts an identity provider
  keeps (SCIM), are never disabled here: the instance keeps an
  administrator, and the provider decides for its accounts.
- **Lock alerts** reach every other enabled administrator in the app's
  bell, which needs no email, and by email when it is set up. Past ten
  locks within an hour, one last alert says many accounts are locking and
  the rest wait in the sign-in trail: a guessing run over many accounts
  must not flood anyone.

## Rejected

- **A domain list of its own for invitations.** Two lists of the same
  domains drift apart.
- **Disabling idle administrators.** An instance could lose its last one.
- **An alert for every lock, whatever the count.** It turns an attack
  into an administrator's inbox flood.

## Consequences

- Without email, idle accounts are disabled without warning, and the
  Security tab says so.
- A person whose account was disabled for inactivity asks an
  administrator, who enables it from Accounts.
