# 0038 — SCIM 2.0: accounts and groups kept by the identity provider

- Status: Accepted
- Date: 2026-11-08

## Context

Organizations that sign in through OIDC or SAML want their identity
provider (Okta, Microsoft Entra ID, Google, JumpCloud, …) to also create
accounts before the first sign-in, deactivate them the day someone
leaves, and keep groups that give access. Until now an account appeared
at its first SSO sign-in and stayed until an administrator disabled it,
and access was given person by person.

## Decision

- **SCIM 2.0 (RFC 7643, RFC 7644) under `/scim/v2`**: `Users`, `Groups`,
  `ServiceProviderConfig`, `ResourceTypes`, `Schemas`. Lists take one
  `attribute eq "value"` filter, the form providers send before creating;
  any other filter is refused with `invalidFilter`. PATCH takes `add`,
  `replace`, and `remove`, with or without a path, as Okta and Entra ID
  send them. No bulk, sort, or ETags.
- **A bearer token made by an administrator**, shown once; only its
  SHA-256 is kept. A request acts as the administrator who made the
  token, and stops working when that person is no longer an active
  administrator. Changes are audited with the source `scim`; creating
  and revoking tokens are audited without their hash.
- **Accounts stay keyed by email.** A user's email is its primary email,
  or its `userName` when that is an email. The `userName` and
  `externalId` the provider uses are kept beside it.
  - Creating a user whose email has an account no provider keeps takes
    over that account: one made by a sign-up or an SSO sign-in, or one
    the provider removed.
  - `active: false` disables the account and ends its sessions; its API
    tokens stop.
  - DELETE disables the account, takes it out of its groups, and hides
    it from SCIM: its history, its own roles, and what it wrote stay.
    Creating it again brings it back.
  - The last active administrator cannot be deactivated or removed.
  - SCIM never sets a password or the administrator flag. Provisioned
    people sign in through SSO.
- **Groups give roles on bases.** A base's owner gives a group a role in
  the base's settings. Each member then gets a role binding marked with
  the group: every access check reads bindings, so nothing else changes.
  - Bindings follow the group's members and roles in the same
    transaction, by difference: the audit trail shows who gained or lost
    what, and when.
  - A role a group gives and a person's own role add up: the stronger
    applies. Removing a member from a base removes their own role only.
  - Groups give roles on bases, not table overrides.

## Consequences

- An organization deprovisions in one place, and access follows at once.
- Groups exist only through SCIM: an administrator cannot create one by
  hand. Instances without a provider see no change.
- A group can be given the owner role. If the provider then empties the
  group, the base may be left without an owner; an administrator can give
  one back.
- Changing an account's email through SCIM changes how it signs in, as
  the provider is the source of truth for identities.

## Rejected

- **Hard deletion on DELETE.** A provider's mistake would erase people's
  history; the audit trail would lose their name.
- **Group bindings computed at each check.** Every reader of bindings
  (members, notifications, collaborators, owners) would need to join the
  groups; marked bindings keep one source of truth.
- **One token per instance in the settings.** Separate tokens let a
  provider move from one to another without a gap, and say who made each.
