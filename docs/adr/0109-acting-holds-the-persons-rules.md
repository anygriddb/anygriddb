# 0109 — Acting as someone holds to that person's rules

- Status: Accepted
- Date: 2026-11-21
- Amends: 0091 (an administrator acts with another person's rights)

## Context

Acting as someone took the person's roles, and kept the rest of the
administrator's: their field and row rules, what only an administrator may
do, and on a route other than the app's own procedures, a change written
without the person's name. A socket kept the identity it opened with after
acting ended, and an administrator who lost that role kept acting.

## Decision

- **The person's rules.** While acting, a read takes the person's field and
  row rules, and "me" is the person, on every route a session reaches. The
  administrator stays the author of what is written.
- **None of the administrator's powers.** What is decided by being an
  administrator is refused, outside the one call that stops acting.
- **No job.** A job runs later, with its author's rights, which are the
  administrator's. Starting one while acting is refused, and says so.
- **It ends with the role.** A session whose administrator is one no longer
  stops acting at its next request.
- **A socket follows.** One whose session now holds another person's rights
  is asked to reconnect, and opens again as who the session is now.

## Rejected

- **Carrying the person on the job.** It adds a column and a second way for
  a job to be authorized, for a gesture meant to see what someone sees.
