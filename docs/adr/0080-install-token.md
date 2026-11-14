# 0080 — The first account takes a token from the command line

- Status: Accepted
- Date: 2026-11-14
- Relates to: 0058 (a sign-up proves its address), 0043 (security
  policy), 0003 (the stack's own PostgreSQL)

## Context

The first account made on an instance administers it, and was made at
once, with no proof of anything: ADR 0058 proves an address by a mailed
link from the second account on, since an empty instance has no mail
yet. Whoever reached the sign-up page of a new instance before its
operator became its administrator. An instance is reachable from the
moment it starts, and its operator is not always the first to arrive.

## Decision

- **The first account takes a token.** While the instance has no
  account, `auth.signup` refuses a sign-up that does not carry it.
- **Only the operator can ask for it**: `anygriddb install-token`, run
  where the instance runs (`docker compose exec app anygriddb
install-token`). Who can run a command in the container already holds
  the instance; who can only open its page does not.
- **It is printed to that terminal and nowhere else.** Never to the
  log, which an instance may ship to a collector; never to a page or an
  answer of the API. The database keeps its hash.
- **It works once, for an hour.** Asking again replaces it. The command
  gives none once the instance has an account.
- **A sign-on through a provider makes no first account**: it has no
  place to give the token. The first account is made from the password
  form; the provider is set up after, or signs the others in from the
  environment's settings.
- The sign-in trail keeps that a token was asked for and that it was
  used, never the token.

## Rejected

- **Writing the token to the log at start.** It is the common way, and
  it puts a secret that makes an administrator where logs go: a
  collector, a support bundle, a terminal left open. It also ties a new
  token to a restart.
- **A token valid until used.** A token asked for and forgotten would
  wait for whoever finds it.
- **Asking for the token only while one is in force.** The first pass of
  this did: past its hour, the sign-up was open again, which is the very
  case of an instance left alone.
- **`ADMIN_EMAILS` in its place.** It names who is promoted, and keeps
  no stranger from being first.

## Consequences

- Installing takes one command more, and the guide says so where it
  says to start the stack.
- A wrong, used, or expired token is answered alike: which of the three
  it is tells a stranger something, and the operator nothing new.
- Tests and the journeys make their first account as an operator does:
  they ask for the token first.
