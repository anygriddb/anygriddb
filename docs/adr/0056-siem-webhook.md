# 0056 — SIEM webhook for auth events

- Status: Accepted
- Date: 2026-11-11

## Context

Operators already scrape `/metrics` and ship JSON logs. They also asked for
a push of security-relevant auth events into their SIEM without embedding
a dashboard in AnyGridDB.

## Decision

- **Opt-in HTTPS webhook** under Administration > Integrations. URL must
  be public HTTPS (same SSRF rules as product webhooks). HMAC secret
  sealed with `AUTH_ENCRYPTION_KEY`.
- **Selected `auth_events` only:** login failures, locks, unlocks, session
  and factor/token revocations, settings changes, account disable/erase,
  SSO unlink. Payload: action, ids, method, detail, IP, time — never an
  email, password, or token.
- **Delivery** is a graphile-worker task with bounded retries. Failures
  do not roll back the trail write.
- **Support bundle** reports only a boolean.

## Rejected

- Built-in Grafana or alerting UI.
- Syslog / native SIEM agents in the image.

## Consequences

- Operators map the JSON and `x-anygriddb-signature` header in their
  collector. Test sends one `settings_changed` event with detail `siem`.
