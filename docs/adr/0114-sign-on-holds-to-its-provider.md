# 0114 — A sign-on is held to what its provider said

- Status: Accepted (amends 0043, 0053)
- Date: 2026-11-22

## Context

A sign-on opened a session and forgot where it came from. A session did not
know the provider's session had an end, or that it had been closed. "Single
sign-on only" was asked at one step of the password form. Trusting the
provider's second factor also covered administrators, whom the security policy
promises never to leave without one. An account bound to a subject was refused
when its address stopped being verified, though the subject is what identifies
it.

## Decision

- **The subject first.** A bound subject finds its account, whatever the
  provider now says of the address, or if it sends none. Only a first binding
  reads the address. It never reaches an account a subject already holds on the
  same provider, or on the other protocol while that provider is set up. A
  provider replaced by another does not hold its accounts. The person is told
  by mail when an account that existed is bound.
- **An administrator always has a factor of their own,** whatever
  `ssoMfa` says. For anyone else under `ssoMfa: "provider"`, a provider that
  says it asked a single factor (`amr`, `acr`, the SAML authentication class)
  does not replace the factor the account has here. A provider that says
  nothing keeps the instance's choice.
- **A session remembers its provider** (`sessions.sign_on`, `sign_on_sid` as a
  hash, `must_end_at`), and so does a sign-in waiting for its second step. It
  never outlives the end a SAML assertion sets.
- **"Single sign-on only" holds where a session is made,** so a sign-in begun
  with a password does not finish after it is turned on. The sign-in form gives
  one answer to a right password, a wrong one, and an unknown address.
  Turning it on offers to end password sessions and revoke the API tokens of
  everyone but administrators: tokens run scripts, so it is asked, not done.
  Under it, the last provider and the last administrator with a password stay.
- **An ID token's signature is checked** against the keys the provider
  publishes, on top of the TLS channel.
- **A SAML assertion names this service** when it names a recipient, and the
  certificate field holds several certificates, for a rotation without a cut.
- **OIDC Back-Channel Logout** ends the sessions the provider names, from a
  token signed by its published keys and taken once.
- **Signing out does not sign out of the provider.** It would end the person's
  other applications. The next sign-on from that browser asks the provider to
  authenticate them again.

## Consequences

- An administrator who signed in through a provider with no factor here has to
  enrol one. This is announced first in the release's notes.
- A provider must sign ID tokens with a key it publishes.
- Bindings made before SAML addresses stopped being trusted (ADR 0111) stay:
  removing them would sign out legitimate people. Operators are asked to review
  them (`docs/operations.md`).
