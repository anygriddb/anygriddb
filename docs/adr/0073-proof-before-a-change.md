# 0073 — Every change made in Administration asks for the proof

- Status: Accepted
- Date: 2026-11-14

## Context

Before a sensitive action, an administrator gives their password or
second factor again, unless they did in the last five minutes: a session
left open, or taken over, cannot give administration away. Each
procedure asked for it on its own, so the list of what asked was the
list of what someone had thought of. Giving a role asked; taking it away
did not. Changing single sign-on asked; changing the mail relay, the
settings, a provisioning token, or who is a member of a base did not.

## Decision

- **One rule on the server, by what a procedure is.** Every change
  (mutation) of Administration asks for the proof, before its input is
  read. A change added later asks without a word.
- **What asks nothing is a short list, each with its reason**
  (`proof-rule.ts`): the proof itself; what only takes access away at
  once (ending a session, revoking a token, switching an automation
  off, revoking a link, withdrawing an invitation); unlocking an
  account; stopping a job; the update notice; what concerns the
  administrator alone (their alerts, a test mail to their address);
  what tries a connection and keeps nothing; what reads (a file's
  preview, the exports, which an auditor makes and cannot prove for).
- **Asked of those who may change something**: an administrator, or
  support. Anyone else is refused by the procedure itself, as before,
  and is not told to prove anything.
- **One place on the screens.** A change refused for want of the proof
  opens the dialog, and is sent again once the proof is given
  (`lib/proof.ts`, mounted once in Administration). A screen needs no
  word about it; those that ask before sending still may.
- **A test walks the router**: each change either asks or is on the
  list, and the list names only changes that exist.

## Rejected

- **A longer list of what asks.** It is the same list with the next
  omission in it.
- **Asking nothing of the "harmless" settings.** Which setting is
  harmless is a judgement made again at every new setting; the sign-up
  policy, the banner everyone reads, and the mail's sender are not.
- **A longer window.** Five minutes covers a sitting of changes with one
  question; a session that stays open longer than that is the case the
  proof is for.

## Consequences

- An administrator who changes several things in a row is asked once
  every five minutes.
- A script cannot make these changes: Administration refuses API tokens
  already.
- Tests of Administration give the proof once after signing in.
