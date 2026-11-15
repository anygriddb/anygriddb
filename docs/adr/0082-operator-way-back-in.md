# 0082 — An operator's way back in

- Status: Accepted
- Date: 2026-11-15
- Relates to: 0080 (the install token), 0053 (SSO-only keeps
  administrators a password), 0055 (sign-in addresses), 0043 (security
  policy)

## Context

Administration keeps one active administrator at least. It cannot keep
that administrator able to sign in:

- the only administrator forgets a password where no mail goes out, or
  loses a second factor with its backup codes, and nobody is left to send
  a link or remove the factor;
- every administrator signs in through the identity provider, which
  keeps them no password (ADR 0053), and the provider is out of reach;
- the list of sign-in addresses (ADR 0055) leaves out the network the
  administrators are on: it gates every interactive sign-in, theirs too.

The only way back was SQL typed into the instance's database, by someone
who knows its tables, with nothing on the sign-in trail.

## Decision

- **One command**, `anygriddb admin recover --email <address>`, run
  where the instance runs. As for the install token (ADR 0080): who can
  run a command in the container already holds the instance; who can only
  open its pages does not.
- **It makes the account of that address an active administrator**
  (an administrator if it was not, enabled if it was disabled) **and
  prints a link that sets its password**, once, within the hour: the link
  a person asks for themselves, printed to that terminal and nowhere
  else.
- **Second factors stay unless `--clear-factors` is given.** A link
  alone never opens an account that has a factor (ADR 0043), from the
  command line either. With the flag, the account's factors and sessions
  go, and it enrols again as the policy asks.
- **`--create <name>` makes the account when the address has none.**
  Without it an address nobody has is refused: a mistyped address makes
  no administrator.
- **An account its identity provider signs in is refused.** It keeps no
  password (ADR 0053). The operator names another address with
  `--create`, and that administrator puts the provider right.
- **`--any-address` empties the list of sign-in addresses.** Without it
  the command says how many ranges still limit sign-in.
- **On the sign-in trail**, each thing changed, as done from the command
  line and under no account's name, since nobody was signed in. An
  instance that ships its trail to a collector ships these too.
- **Asked twice**, it changes nothing the second time and replaces the
  link. It does nothing on an instance with no account, whose first is
  made with the install token, and nothing for the address erased
  accounts take.

## Rejected

- **A command that removes the single sign-on settings.** It lets nobody
  in: an administrator with a password signs in without the provider
  already, and one without gains none by it.
- **A token asked for by one command and spent by a second.** Both run
  in the same terminal, by the same person: the token proves nothing.
- **Acting only when no active administrator is left.** Administration
  never leaves an instance without one. What happens is an administrator
  who is there and cannot sign in.
- **A password given on the command line.** It would stay in the shell's
  history and show in the list of processes.
- **Mailing the link.** The command is for the day mail does not go out,
  or goes to a mailbox nobody opens.

## Consequences

- Whoever holds the host can make an administrator. They could before,
  through the database; now it shows on the trail and at the collector.
- The guide says when to run it (`docs/operations.md`, "When no
  administrator can sign in"), and a journey runs it as an operator does.
- A disabled account enabled this way leaves `account_updated` with the
  detail `enabled` on the trail.
