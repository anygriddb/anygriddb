# 0111 — SAML trusts an address only when told to

- Status: Accepted
- Date: 2026-11-22

## Context

The first sign-in of a person through a provider finds their account by
address. OIDC says whether the provider verified that address, and an
unverified one never reaches an account that exists. A SAML assertion has no
such claim, and it was taken as verified. At a provider where people may edit
their own address, anyone could give themselves the address of an account
here and sign in as that account, an administrator's included when the second
factor is left to the provider.

## Decision

- **Off by default.** A SAML assertion reaches an existing account by address
  only when an administrator says this provider verifies addresses, in
  Administration or with `SAML_TRUST_ADDRESSES`.
- **What is already bound stays.** An account bound to a persistent NameID
  signs in as before, and a new address still makes a new account when the
  sign-up policy allows it.
- **An instance that upgrades starts with it off,** and is told so first in
  the release's notes: the choice is about its provider, and only its
  administrator knows it.

## Rejected

- **On for instances that already have SAML.** It would keep the flaw exactly
  where it can be used, without anyone having decided it.
- **Reading a verification attribute from the assertion.** SAML has no standard
  one, and each provider would need its own mapping.

## Consequences

With a provider that sends transient or address NameIDs, nobody who has an
account signs in until the administrator turns it on. An administrator locked
out that way sets `SAML_TRUST_ADDRESSES`, or uses the recovery command.
