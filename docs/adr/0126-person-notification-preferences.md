# 0126 — Preferences for person notifications

- Status: Accepted
- Date: 2026-11-24
- Relates to: 0043 (security mail), 0052 (operator mail), 0074 (emergency
  access), 0091 (acting as), 0092 (instance notification channels)

## Context

Instance channels have a provider registry, chosen events, and delivery
jobs (ADR 0092). A person had one switch: `users.notify_by_email`. Mentions,
replies, assignments, automation and webhook failures, role notices, and
security mails all shared that bit or ignored it. There was no way to keep
the bell and silence a noisy table, nor a digest, nor an unsubscribe link
that did not ask for a sign-in.

## Decision

- **One catalogue of person events**, declared in code from the inventory
  of what already notifies a person (bell kinds, security mails, emergency
  and acting notices). Instance channels stay a separate catalogue.
- **Four channels:** in the app, immediate email, daily digest, weekly
  digest. A person chooses, per event, which channels apply. An empty
  choice turns the event off, except where channels are required.
- **Instance defaults** are rows an administrator sets; each person
  inherits them until they save their own. Code holds the built-in
  defaults used before any administrator touch.
- **Required channels cannot be removed.** Immediate email stays on for:
  the person's own account lock, password change, second factors removed,
  SSO linked, inactivity warning and disable (`locked`,
  `password_changed`, `factors_removed`, `sso_linked`, `inactive_soon`,
  `inactive_disabled`) — those are the only warning of a compromise or of
  a disable; and for `admin_access` and `acting_as` — an administrator
  used emergency powers on the person's base or as the person. The person
  may still silence the bell on those last two.
- **A mute** on a base or a table stops scoped events from that place.
  Account and security events are never muted that way.
- **A person is never told about a row or table they can no longer read.**
  Delivery asks the same role check the product already uses for reads
  (`roleAllows` / `effectiveTableRole`) before writing the bell or the
  mail. When a unified authorization surface lands, delivery calls that
  instead; the rule does not change.
- **Every preference email carries an unsubscribe link** that adjusts that
  event's channels without a session. Required immediate email refuses
  the change and says why. Invitations and the administrator's operational
  broadcast stay outside the catalogue (ADR 0052).
- **`notify_by_email` becomes preferences.** Accounts that had it off get
  collaborative events as in-app only; accounts that had it on keep the
  built-in defaults (in-app and immediate email). The column is then
  dropped. Mail still goes through `sendMail` / the configured relay.

## Rejected

- **Folding person preferences into instance channels.** Channels speak to
  operators' tools; person events speak to an account. Mixing them would
  put personal mutes next to webhook secrets.
- **Letting required security events be turned off.** A stolen session
  that silenced them would leave the owner without the warning.
- **A new mail path.** The product already has one relay and `sendMail`.

## Consequences

- The account page shows a matrix of events and channels, and the mutes.
- Administration shows the instance defaults.
- Daily and weekly digests are cron jobs that send through the same relay.
- Call sites that inserted into `notifications` and mailed on their own
  (emergency access, lock alerts, acting as) go through the same delivery
  helper so preferences and authorization apply once.
