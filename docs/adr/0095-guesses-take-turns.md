# 0095 — Guesses at an account take turns, and a request carries one

- Status: Accepted
- Date: 2026-11-16
- Relates to: 0043 (the lock), 0009 (what is kept in memory)

## Context

An account locks after a number of wrong passwords or codes (ADR 0043),
and an address sends twenty sign-in requests a minute. Both counted too
late. The app's calls travel in batches, so one request could name sixty
sign-ins and count once; and a wrong guess is counted after it is
compared, so guesses that arrive together were all compared before the
first one counted. Sixty sign-ins sent in one request tried fifty-one
passwords before the lock set at ten.

## Decision

- **A request names one credential check at most.** A call that checks a
  password, a code or a secret link, or that mails one, travels alone
  among such calls: a request naming two is refused (`rate-limit.ts`).
- **Guesses about one account take turns.** Before such a call runs, it
  waits for the one before it about the same subject: the address a
  sign-in names, else the sign-in under way, the session or the token.
  Each guess then sees the count and the lock the last one left. One is
  compared and four may wait; a fifth is refused at once
  (`too_many_attempts`), so a flood holds neither memory nor a
  connection (`auth/guess-turns.ts`).
- **A second factor's wrong codes are counted in one statement**, in the
  database.
- **A request carries a hundred calls at most**; the app sends fifty.

## Consequences

- No more guesses are compared than the policy allows, however they are
  sent, within one process.
- Turns are kept in memory, as rate limits are (ADR 0009): with several
  API processes, as many guesses as processes may be compared together
  before the lock.
- A person who submits a sign-in form several times at once waits for
  each answer in turn.

## Rejected

- **Counting a guess before comparing it, in the database.** Exact across
  processes, but every one of the nine places that compare a credential
  would have to give the guess back on a success, and one forgotten
  would lock people out for signing in.
- **Holding the account's row locked while a password is compared.** A
  flood of guesses would hold as many connections as the pool has.
- **Refusing batches.** The app's pages depend on them.
