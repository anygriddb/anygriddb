# 0091 — An administrator acts with another person's rights

- Status: Accepted
- Date: 2026-11-15
- Relates to: 0042 (the sign-in trail), 0071 (an auditor reads), 0073 (the
  proof), 0074 (an administrator opens a base as themselves)

## Context

An administrator can preview one person's rights on one table, and can
open a base they are not in, as themselves, for an hour. They cannot
see that person's home, or do what that person can do, without that
person's password.

## Decision

- **The session stays the administrator's.** A cookie is never swapped.
  For thirty minutes the request uses the other person's rights. An API
  token ignores this. It ends at the time, when the administrator stops
  it, or when the person can no longer be acted as.
- **Who may.** An instance administrator, after the proof, with a short
  reason. Not support, not an auditor. Not themselves, not another
  administrator, not support, not an auditor, not a disabled account,
  and not the erased account. A second start does not extend the time.
- **Who is written.** The author of every change is the administrator.
  `audit_events.impersonated_user_id` names the person, and is empty
  otherwise. The sign-in trail records the start and the end, with the
  reason and no address. Pages viewed are not a second log.
- **Administration is closed** while this lasts, except stopping.
  Stopping asks for no proof.
- **The person is told**, in the application and by mail. A mail that
  fails is logged and does not undo the start.
- **Erasure.** The column follows the author to the tombstone. Deleting
  the person clears it on the session, and the gesture ends.

## Consequences

- A change made this way reads, on a row and on the trails, as the
  administrator acting as the person. It never reads as the person alone.
- Two administrators may act as the same person. A row they both write
  is settled as any two writers are.

## Rejected

- **Signing the change as the person alone.** That would be their
  signature on an act they did not make.
- **A second session cookie.** The administrator would be signed out of
  their own account, and stopping would depend on finding it again.
- **Logging every page.** The change trail already keeps what was
  written. A line per page would be another log.
