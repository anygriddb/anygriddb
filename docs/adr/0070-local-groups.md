# 0070 — Local groups in Administration

- Status: Accepted
- Date: 2026-11-13

## Context

ADR 0038 said groups exist only through SCIM: an administrator could not
create one by hand. Instances without an identity provider had no groups,
and every membership change waited on the provider. Administrators still
needed named sets of people they could give a role on a base.

## Decision

- **Same `groups` table.** A local group is a row with `provider` null. A
  SCIM group has `provider = 'scim'`. An optional `description` holds a
  short note for people reading the list in Administration.
- **Administration owns local groups.** An administrator creates, renames,
  describes, and deletes them, and adds or removes members. Membership of
  a SCIM group stays read-only in the product; the provider keeps it.
- **A base still gives a group a role** in its settings, and an
  administrator may also grant or revoke that role from Administration.
  Bindings keep following members and roles as in ADR 0038.
- **SCIM lists and changes only `provider = 'scim'` rows.** A local group
  is not a SCIM resource; looking it up by id answers 404.

## Consequences

- An instance without SCIM can still use groups.
- A name stays unique across local and SCIM groups (`groups_display_name`).
- ADR 0038's rule that groups exist only through SCIM no longer holds;
  everything else about how a group gives roles on bases stays.

## Rejected

- **A separate `local_groups` table.** Two membership and role tables would
  double every reader of bindings; one table with a null provider keeps
  the sync path unchanged.
- **Editing SCIM membership in Administration.** The provider would
  overwrite the change on the next sync; read-only membership avoids that
  fight.
