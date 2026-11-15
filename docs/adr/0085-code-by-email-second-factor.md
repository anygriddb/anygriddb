# 0085 — A code by email as a second factor, for anyone but an administrator

- Status: Accepted
- Date: 2026-11-15
- Relates to: 0015 (sessions and the second step), 0043 (who must have
  a second factor), 0050 (mail set up in Administration), 0072 (the
  instance's voice in mail), 0073 (the proof before a change)

## Context

A second factor was an authenticator app or a passkey. A person with
neither a phone that runs one nor a device that holds the other could
not meet the policy that asks owners, or everyone, for a second factor.
Instances that send mail already reach every account at an address it
proved.

A code sent to that address is a weaker factor than the other two: the
mailbox it reaches is also the one a forgotten password is reset from.
Whoever holds the mailbox holds both steps.

## Decision

- **A third factor, chosen, never automatic.** A person turns it on
  from their account's second factors, where mail is set up. A sign-in
  mails nothing to an account that did not choose it, and nothing until
  the person asks for the code.
- **Never an administrator's.** An administrator is refused it, and it
  is not counted for one: their sign-in does not offer it, and the
  policy still asks them for an authenticator app or a passkey. A member
  who chose it and becomes an administrator keeps it, unused, and has it
  again if they stop being one. The proof Administration asks before a
  change (ADR 0073) takes no code by email, for the same reason.
- **For everyone else it counts.** Where the policy asks owners, or
  every account, for a second factor, a code by email is one.
- **One more way in is asked for like one.** As an account's first
  factor it needs no proof beyond the code itself, which proves the
  mailbox. Beside an authenticator or a passkey, adding it asks for the
  password or the authenticator's code first: a borrowed session must
  not add a way round a stronger factor. Turning it off asks the same.
- **The code.** Six digits, mailed in the instance's voice, alone on
  its line, with no link. Kept as an HMAC under the instance's key, one
  at a time for an account and a purpose (choosing the factor, signing
  in), ten minutes, five guesses. A guess is counted before it is
  compared, in one statement, so guesses sent together are each counted.
  A wrong code at sign-in counts toward the account's lock, as a wrong
  authenticator code does.
- **What a mailbox receives is bounded.** One code a minute and five an
  hour, for an account and a purpose, decided in the statement that
  makes the code. A send the mail server refuses still counts.
- **The mail says what it means.** A sign-in code is asked for with the
  right password: the mail tells whoever did not ask that their password
  is known, and to change it.
- **Backup codes.** Choosing it gives backup codes to an account that
  has none; the ones an account saved stay good.
- **Mail down.** The factor stays asked for at sign-in: the second step
  is never skipped. The person signs in with a backup code, or an
  administrator clears their factors.

## Rejected

- **Counting it for administrators.** An administrator's mailbox would
  then hold the whole way into Administration.
- **A code mailed at every sign-in once mail is set up.** It would put
  a second step on accounts that never chose one, and send mail nobody
  asked for.
- **Another address for the factor.** The account's own is already
  proved, at sign-up or by an administrator; a second one would need its
  own proof and its own way to change.
- **A code by email as the proof in Administration.** Only
  administrators give that proof, and it is not theirs to use.

## Consequences

- `auth.email` has five procedures: `begin`, `confirm`, `disable` for
  the account's settings, `send` and `verify` for the sign-in's second
  step. Sign-in events carry the method `email`.
- Two tables, `email_factors` and `email_otp_codes`, which leave with
  the account. Clearing an account's factors in Administration clears
  them too.
- Deleting one's own account, when a code by email is its only factor,
  asks for the password and a recent sign-in, as with a passkey.
