# 0071 — An auditor reads Administration and changes nothing

- Status: Accepted
- Date: 2026-11-14

## Context

Administration had two kinds of people: administrators, who do
everything, and support (ADR 0054), who help a person sign in again.
Someone who must check how an instance is run (who has access to what,
what leaves it, what was done and by whom, how it is secured) had to be
made an administrator, and so given every power to read a few pages.

## Decision

- **`users.is_auditor`.** An administrator gives the role and takes it
  away, with the proof a sensitive action asks for, and both are written
  to the sign-in trail. The role adds to what the account already is; an
  administrator needs no such role.
- **One rule, by what a procedure is.** An auditor may call every read of
  Administration and the three exports (the change trail, the sign-in
  trail, who has access), each of which is written to the change trail
  under their name. Every other procedure refuses them before it reads
  its input. The rule is not a list of the reads: a read added later is
  open to the auditor, and a change added later is refused, without a
  word in either case.
- **One read is kept out:** listing the tables of a client's database,
  which goes out to that database and names tables the instance does not
  show.
- **A read never carries a secret.** That already held for
  administrators: a page shows that a password or a key is set, never the
  value. The auditor relies on it.
- **Screens.** Every section opens. A page is drawn inside a region that
  is only read: each control of the interface kit is off there unless it
  says that it only reads (a search, a filter, the next page, an export),
  so a control added later is off too.
- **The same session rules** as an administrator: their own session, no
  API token, a second factor.
- **No base opens** to an auditor who is not a member of it: the role
  reads Administration, not the data of the bases.

## Rejected

- **A list of capabilities per procedure.** It says the same thing as the
  rule in a hundred lines, and a procedure left out of the list would
  need someone to notice.
- **No export for the auditor.** Evidence is what an audit keeps, and an
  export is traced where a page read is not.
- **Hiding the pages that hold settings.** How an instance is secured is
  what an auditor comes to read.

## Consequences

- Session payloads carry `isAuditor`.
- The account manager and the source manager of the roadmap are not part
  of this: they change things, and need their own rule.
- An account that is support and auditor keeps what support may do.
