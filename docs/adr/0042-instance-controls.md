# 0042 — Instance controls: a sign-in trail, maintenance, and account support

- Status: Accepted
- Date: 2026-11-09

## Context

Operators asked what an administrator of a self-hosted instance needs
without a shell: who signed in or failed to, a way to keep people out
during an upgrade, a second factor for everyone, and help for a person
who lost a phone or leaked a token. A worktree proposed these, with a
process restart button, a second Prometheus registry, and an
administrator's invitation into any base.

## Decision

- **A sign-in trail, `auth_events`, apart from `audit_events`.** It keeps
  sign-ins, refusals, sign-outs, ended sessions, removed factors, and
  revoked tokens: the account when known, the administrator who acted
  (`actor_id`), a method, a stable detail code, and the client address.
  Never an email, a password, or a token. A trigger keeps it
  append-only, with two exceptions: an event older than a year may be
  deleted, by the hourly purge, and erasing an account may clear the ids
  and the address that point to it (the CNIL's guidance on logs: six
  months to a year). Administration > Audit log > Sign-ins reads it and
  exports it as CSV.
- **Maintenance.** While it is on, only administrators open a session or
  use a token; turning it on ends everyone else's sessions and closes
  their sockets. `createSession` refuses the others with
  `instance_maintenance` (503), and so does every request that resolves a
  person (tRPC, REST, MCP, files).
- **An announcement** of 500 characters at most, shown above the app and,
  during maintenance, on the sign-in page.
- **A second factor for every account**, as an instance setting, through
  the enrollment gate that already holds owners to it.
- **Account support:** end one session, all of a person's, or everyone
  else's; remove a person's factors and backup codes (never one's own);
  revoke their API tokens. Each names its actor in the trail.
- **Support:** every person's jobs, which an administrator may cancel;
  webhook deliveries that failed, with the target's host only; pending
  invitations, which an administrator may withdraw; a CSV of who has
  access, with each account's last sign-in from the trail; a test email
  to oneself; a support bundle of health and configuration facts,
  without data, addresses, or secrets.
- **CSV exports** prefix a field that a spreadsheet would run as a
  formula (`=`, `+`, `-`, `@`) with a quote.
- **Removing a member closes their sockets** so the app reconnects and
  each channel is authorized again, instead of ending their sessions.
- The settings these gates read are cached five seconds per process; a
  write clears the cache of the process that made it.

## Rejected

- **Restarting the API from the browser** (`process.exit`). Whether it
  comes back depends on a supervisor's policy; an operator restarts a
  service with the tool that runs it.
- **An administrator's invitation into any base.** It would let an
  administrator give themselves any base's data. Inviting stays the
  owners' decision; an administrator only withdraws a pending invitation.
- **Unlocking an account.** No account is locked: five wrong codes end a
  sign-in attempt, and the next sign-in starts a new one.
- **A second metrics registry.** `/metrics` already serves `prom-client`
  to the operator's token (ADR 0018).

## Consequences

- Closing sockets acts on the process that handled the request; with
  several API processes, the others' sockets stay open until their next
  authorization, though the ended sessions are refused at once.
- An administrator's own sessions are never ended by these actions.
