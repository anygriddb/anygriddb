# 0052 — Operator mail to instance accounts

- Status: Accepted
- Date: 2026-11-11

## Context

Administrators already configure SMTP, send a test email to themselves,
and show a short in-app announcement. They still had no way to email
accounts about maintenance, a policy change, or an incident without
leaving the product for an external list. Automations and notification
preferences cover event-driven mail, not an operator notice.

## Decision

- **An operator notice, not a campaign tool.** Administration > Support
  offers subject and plain-text body, to **all active accounts** or to
  **chosen account ids**. No HTML, attachments, scheduling, open
  tracking, or marketing features.
- **Operational channel.** The send ignores `notifyByEmail`. Preferences
  stay for mentions, assignments, and automation alerts.
- **Recipients are resolved when the send is queued**, then frozen in the
  worker payload: active means not disabled and not the erasure
  tombstone; a chosen list may include disabled accounts the
  administrator picked, never the tombstone or unknown ids.
- **At most 500 recipients** per send; at most **five** operator sends
  per hour on the instance.
- **Delivery is a graphile-worker task** (`operator_mail`), not a product
  job. Each address is sent on its own; one failure is logged by account
  id and does not stop the others. A fixed footer says an administrator
  of the instance sent the message (instance default locale).
- **The sign-in trail** records `operator_mail_sent` with the
  administrator as `actor_id`, `method: admin`, and detail `all_active`
  or `selected`. No email address and no body in the trail or in logs.
- **No message archive** in the database beyond the short-lived worker
  payload.

## Rejected

- Respecting `notifyByEmail` for these notices (would silence operational
  mail people need).
- HTML bodies or a stored template library (campaign product, tracking
  risk).
- A product `JobKind` with progress UI (overkill for a short fan-out).

## Consequences

- SMTP must already be ready (`smtp_not_configured` otherwise), as for
  the test email and password resets.
- Large instances above 500 active accounts must send in batches by
  selection until a later decision raises the cap.
