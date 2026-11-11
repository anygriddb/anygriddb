# 0059 — An administrator deletes an account in one step

- Status: Accepted
- Date: 2026-11-11
- Supersedes: in ADR 0051, "erase only a disabled account"

## Context

ADR 0051 made disabling the departure, and erasing a second step offered
only once the account was disabled. People looking for "Delete" did not
find it until they had already disabled the account, and two calls from
the page could leave an account disabled and not erased.

## Decision

- **Delete is offered whatever the account's status**, with the same
  typed email and the same successor for the bases it alone owns.
- **One transaction** disables an enabled account, ends its sessions,
  writes `admin_disable` on the sign-in trail, then erases it on the path
  of ADR 0051. A refusal (wrong email, no successor, the last active
  administrator, an account its identity provider still manages) writes
  nothing.
- Self-service erasure and SCIM-managed accounts are unchanged.

## Consequences

- Disabling stays the gentler step for someone who may come back:
  Administration offers both, and says which keeps the data.
