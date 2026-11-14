# 0075 — Handing a leaving person's work to someone who stays

- Status: Accepted
- Date: 2026-11-14

## Context

When someone leaves, what they alone own must not leave with them: a
base with no owner who stays, automations and webhooks that run in
their name. Deleting the account names who takes its bases (ADR 0059),
and takes everything else away with it. An organisation often wants the
account kept, disabled or not, and its work in other hands first.

## Decision

- **An administrator hands over, from the person's account**, to an
  active account they choose: their own if they wish. One gesture, in
  one transaction, under the administrator's name on the change trail,
  and on the sign-in trail of the person's account.
- **The bases the person alone owns get the successor as an owner.**
  The person's own role is left: taking it away, or disabling the
  account, is another gesture, and a base owned with someone else
  already has an owner who stays.
- **An automation or a webhook moves only where the successor may
  manage its table**, once those bases are theirs. It runs with its
  author's rights: moved anywhere else, it would run with rights nobody
  gave it. What cannot move stays with the person, and the answer names
  each one, with its table and base: giving the successor a role there
  and handing over again moves it.
- **API tokens are never handed over.** A token is a person's own key;
  the administrator may revoke the person's tokens in the same gesture.
- **The dialog says first what there is**, names only: the bases, what
  the person made, how many tokens. Then what moved, and what stayed.

## Rejected

- **Moving every automation and webhook.** In a base the successor has
  no role on, it would read and write there in their name.
- **Switching off what cannot move.** It still works while the person's
  account does; whether to stop it is the base's owners' call, and the
  administrator is told which ones are concerned.
- **Taking the person's roles away as part of it.** The handover is for
  what must outlast them, not a way to shut them out.

## Consequences

- Handing over twice changes nothing the second time, but what the
  successor has since been given a role to manage.
- Personal views, public links, and calendar feeds are not part of it:
  they still leave with the account when it is deleted.
