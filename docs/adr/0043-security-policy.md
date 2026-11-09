# 0043 — A security policy the administrator sets, from simple defaults

- Status: Accepted (refines 0042's second factor for everyone)
- Date: 2026-11-09

## Context

A self-hosted instance serves organizations with their own rules: how
many failed sign-ins lock an account, who needs a second factor, how long
a session lasts, whether public links may leave the building. One fixed
choice suits nobody, and an empty form suits nobody either. Checking the
code also showed gaps: an administrator worked without a second factor,
nobody could change or reset a password, guesses were limited per address
only, and a sign-in through single sign-on skipped the second factor an
account had set up here.

## Decision

Each rule is an instance setting with a default most organizations keep,
and a floor no setting crosses. Administration > Security sets them; the
API checks the bounds again (`POLICY_BOUNDS`, `packages/core/src/instance.ts`).

| Setting                        | Default                                        | Choices                                                  | Floor                             |
| ------------------------------ | ---------------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| Who needs a second factor      | administrators, owners, anyone creating a base | administrators only, or everyone                         | administrators always             |
| After single sign-on           | AnyGridDB asks its own second factor too       | trust the provider's                                     | —                                 |
| Lock after                     | 10 failed attempts in a row                    | 3 to 20                                                  | never off                         |
| Lock for                       | 15 minutes                                     | 5 minutes to 24 hours, or until an administrator unlocks | an administrator: an hour at most |
| Session idle timeout, lifetime | 15 minutes, 12 hours                           | 5 minutes to 8 hours, 1 hour to 7 days                   | —                                 |
| Password length                | 12                                             | up to 64                                                 | 12                                |
| Who starts a reset             | the person, by email                           | only an administrator                                    | —                                 |
| API token lifetime             | 365 days                                       | 1 to 365                                                 | —                                 |
| Public links                   | allowed                                        | only with a password, or off                             | —                                 |
| Sign-up domains                | any                                            | a list                                                   | —                                 |
| Sign-in trail kept             | a year                                         | six months to a year                                     | six months (CNIL)                 |

- **Locking is per account**, so guesses from many addresses meet the
  same limit; the per-address rate limit stays. Wrong passwords and wrong
  second-factor codes count; a success starts over. A locked account is
  refused before its password is checked, so a lock never tells whether a
  guess was right. The lock lasts from `users.locked_at` for as long as
  the policy says now, so a changed duration applies to locks already
  there. The person gets an email; the trail keeps the lock and who lifted
  it. The default is temporary: a lock that waits for an administrator
  lets anyone who knows an address lock its account. Single sign-on is
  the provider's to lock; its second step here is locked.
- **Passwords**: a person changes theirs (their other sessions end), asks
  for a reset link by email when the instance allows it, or gets one from
  an administrator. A link works once, an hour (asked) or a day (sent by
  an administrator); only its hash is kept. A reset ends every session
  and the lock, and keeps the second factors, so a reset alone never opens
  an account that has one. An account with no password (single sign-on
  only) gets no link. Length is the rule, as NIST SP 800-63B and the CNIL
  advise: no character classes, no change on a schedule.
- **An administrator's reset link** goes to the person's own address when
  email is set up, and the administrator never sees it. Without email the
  administrator gets it to pass on, and the trail names them: an
  administrator can then choose a person's password, which is what helping
  someone without email means. Second factors still guard the account.
- **After single sign-on**, an account with a factor here goes through
  the second step before a session (`/login?mfa=1`). An instance whose
  provider enforces a second factor may trust it: sign-ins through the
  provider skip the step, and an account with no password needs no factor
  here.
- **A shorter policy applies to what exists**: sessions are renewed only
  within the new windows, tokens older than the new lifetime stop, links
  without a password stop when links need one, and open again if the
  setting comes back.
- **Sign-up domains** hold for anyone who comes on their own, by sign-up
  or single sign-on. An owner's invitation, `ADMIN_EMAILS`, and the first
  account pass.
- **The trail keeps who changed which setting** (`settings_changed`, the
  key, never the value), with the administrator and the address.
- Each setting is read on its own: a stored value out of bounds falls
  back to its own default, not every setting's. The `requireMfa` of 0042
  reads as "everyone".

## Rejected

- **Character classes and expiry dates for passwords.** They make
  passwords weaker and get written down.
- **A permanent lock by default.** It turns a guessing attack into a way
  to lock anyone out, and every lock into a ticket.
- **Telling an unknown address apart from a locked one by silence.**
  Sign-up already says whether an address has an account; a clear "locked"
  saves the person a ticket.
- **Showing a reset link to the administrator when email works.** Nobody
  but the person needs to see it.

## Consequences

- Behind a shared address (a company's NAT), the per-address rate limit
  still counts everyone together; the per-account lock does not.
- An administrator without a second factor must set one up before using
  Administration, the first account included.
- A self-service reset needs SMTP; without it, only administrators send
  links.
