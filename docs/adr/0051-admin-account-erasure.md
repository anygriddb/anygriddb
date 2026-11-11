# 0051 — Administrator-initiated account erasure

- Status: Accepted; erasing only a disabled account is superseded by
  [0059](0059-delete-account-in-one-step.md)
- Date: 2026-11-11

## Context

When someone leaves an organization, an administrator can already disable
the account (sessions end, tokens stop). Removing the person's identity
from the instance was only self-service: Settings > Delete account with
their password. Operators asked to erase a departed account without that
password, without inventing a second "deleted user", and without leaving
bases without an owner by surprise.

Self-service erasure already reassigns audit trails to one tombstone
account (`00000000-0000-0000-0000-000000000000`). Comments were deleted
with the person (`ON DELETE CASCADE`), which disagreed with cell values
(table content stays).

## Decision

- **Disable remains the departure action.** Cutting access is not
  removing identity. Erase is a second step when the organization must
  drop email, name, and sign-in material.
- **One erase path.** `eraseAccount` serves both self-service and
  Administration. An administrator confirms by typing the account's
  email. Every refusal is decided in the transaction that erases, on
  the locked account, and the sign-in trail's `account_erased` event,
  with the administrator as `actor_id`, is written in that transaction:
  an erasure that does not happen leaves no trace of one. After the
  delete, `user_id` on that event becomes null (ADR 0042 / CNIL).
- **Guards for admin erase.** The target must already be disabled; must
  not be the actor or the tombstone; must not be actively SCIM-managed
  (`scim_user_name` set and not deprovisioned — the provider owns that
  lifecycle).
- **A live base keeps an owner**, on both paths (same `invalid_owner`
  idea as revoking a member). A person who alone owns a base grants
  another owner, or trashes the base, before erasing their own account.
  For a departed person nobody can: only an owner grants an owner, and
  that owner is disabled. So the administrator types the email of the
  active account that takes those bases, which may be their own. ADR
  0042 keeps an administrator out of a base whose owners can decide;
  this one has none left, and excluding the administrator would only
  send them through a second account while leaving a one-person
  instance without a way out. The hand-over is written in the bases'
  audit as the administrator's act, in the transaction that erases, and
  the erasure itself is in the sign-in trail.
- **The instance keeps an administrator.** The only active administrator
  cannot erase their own account, as they cannot drop their own flag.
- **Comments join the tombstone**, for self-service erasure too, which
  used to delete them. Comment bodies stay; `author_id` moves to the
  erased account, and the FK is `ON DELETE RESTRICT` so erasure must
  reassign first. Residual text that names the person is
  the same class of risk as cell values: a manager deletes the comment
  if the content itself must leave.
- **SCIM DELETE stays disable-only** (ADR 0038). A provider mistake must
  not wipe identity; after SCIM has deprovisioned (disabled), an
  administrator may erase.

## Rejected

- **A second "Deleted user" account.** The tombstone already exists.
- **Auto-transfer of sole-owned bases to the erasing admin.** Surprising,
  and conflates instance administration with base ownership.
- **Refusing the erasure until the base has another owner.** For a
  departed owner it could never be lifted.
- **Erasing and leaving the base without an owner.** Nobody could manage
  it afterwards. Self-service erasure did so until this decision.
- **Hard delete on SCIM DELETE.** Unchanged from ADR 0038.
- **Erasing an enabled account in one click.** Disable first, so the
  departure path stays visible and reversible until identity must leave.

## Consequences

- Personal views, shares, sessions, factors, and invitations still leave
  with the account (cascades and existing erase steps).
- The Administration users list offers Erase only on disabled accounts;
  its dialog asks for the new owner's email when the account alone owns
  live bases.
- Self-service erasure is stricter than it was: it refuses a sole owner
  of a live base and the only active administrator.
- French and English UI copy, `SECURITY.md`, and operations docs name the
  two-step departure path.
