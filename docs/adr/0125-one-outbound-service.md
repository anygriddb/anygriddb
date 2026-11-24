# 0125 — One outbound service for every call that leaves the instance

- Status: Accepted
- Date: 2026-11-24
- Relates to: 0030 (encrypted connections), 0092 (notification channels),
  0101 (a script's fetch), 0105 (syslog from Administration)

## Context

Several paths send requests outside the instance, each with its own
rules: table webhooks (`webhooks.ts`, `webhook_deliveries`), instance
notifications (`notify/`, `integration_deliveries`), automation HTTP
actions and scripts, the change trail's copy to a collector, syslog, and
mail. Two separate guards refused internal addresses
(`requestPinned` and `notify/outbound.ts`), with different redirect and
error contracts. A delivery could be retried on one path and not the
other, and an administrator had two journals for failed deliveries.

## Decision

- **One outbound service** (`apps/api/src/outbound/`) is the only way a
  call leaves over HTTPS. It resolves the address, refuses reserved
  ranges always and private ones unless an administrator has said so,
  pins the socket's DNS against rebinding, verifies the certificate
  (ADR 0030), waits at most ten seconds, reads at most the caller's
  byte ceiling, follows at most one redirect on the same origin
  (checked again), and redacts secrets before anything is stored.
- **One delivery queue and one delivery journal** replace
  `webhook_deliveries` and `integration_deliveries`. A delivery is
  never sent twice: the same subject is keyed once. Retries, auto-off
  after repeated failures, and the sweep of late pending rows are the
  service's. Emitters enqueue; they do not open sockets.
- **One administration screen** lists failed deliveries, filterable by
  origin, and the same journal is shown from each webhook, automation,
  or integration.
- **The notification provider registry** (`packages/core/src/notify/
registry.ts`) stays. Each provider builds a message; the outbound
  service sends it.
- **Migration is one emitter at a time.** Each pull request deletes that
  emitter's old path in the same change. The security tests of the
  service are written first and stay green.

## Rejected

- **Keeping two SSRF guards and wrapping them.** A second path is how a
  private address slips through one of them.
- **Following redirects across origins.** Credentials in headers would
  travel to a host the administrator did not name (ADR 0092).
- **Clear text on a private network.** ADR 0030 refused it.

## Consequences

- Callers that still use `requestPinned` or `notify/outbound` move to
  this service; those modules shrink as each emitter lands.
- A new way out of the instance (another collector, another action)
  adds no socket code of its own: it enqueues through this service.
- Mail stays on its SMTP path for the moment; when it moves, it uses
  the same journal and the same failure screen, not a second one.
