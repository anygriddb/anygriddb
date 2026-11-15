# 0092 — Notifications configured in Administration

- Status: Accepted
- Date: 2026-11-15
- Relates to: 0018 (metrics and traces), 0030 (encrypted connections),
  0050 (integrations in the UI), 0083 (the environment wins)

## Context

An administrator could not be told when a job failed, except by the
daily mail already sent about coarse thresholds. Metrics and traces
existed, and stayed off until the environment named a token or a
collector. Turning one on meant editing that environment and starting
the process again. Table webhooks are a different thing: they follow
rows, and their addresses stay public.

## Decision

- **Channels are rows, not variables.** An administrator adds, changes,
  tests, pauses, and removes them under Administration, Connections,
  Notifications. Nothing new is required in the environment. An instance
  that adds none behaves as before.
- **Each tool is a provider.** It names itself, the fields the form
  draws, and how a message is sent. The screen does not know the tool.
  Adding one does not change the form.
- **Secrets are sealed** with the instance key, under the use `notify`
  (ADR 0066). The API says that a secret is set, and never what it is.
  A blank field on edit keeps the current value. `anygriddb keys rotate`
  rewrites these columns with the others. They are not written to the
  change trail, the sign-in trail, or a log.
- **A save, a change, and a removal** are a `settings_changed` sign-in
  event whose detail is `notify`, with no configuration.
- **Sending is a job.** The work that noticed the event does not wait,
  and does not fail, when a channel is down. A delivery waits at most
  ten seconds, then retries after one minute, five minutes, and thirty
  minutes. The same subject is not sent twice to one channel inside
  five minutes, and a channel starts at most twenty deliveries an hour.
  After five exhausted deliveries the channel is paused and the other
  channels may hear `integration.failing`, once, and not about
  themselves.
- **Addresses are HTTPS, and the certificate is checked** (ADR 0030).
  Loopback, link-local, carrier-grade NAT, and cloud metadata are
  refused, including after DNS and one redirect. A private address is
  refused too, unless the administrator turns on private networks.
  That switch does not allow clear text, and it does not change table
  webhooks.
- **Metrics and traces may be saved the same way** when the environment
  does not already set them (this amends the environment-only list in
  0050, and the token and endpoint in 0018). When the environment sets
  `METRICS_TOKEN` or `OTEL_EXPORTER_OTLP_ENDPOINT`, it wins (ADR 0083)
  and Administration shows that and cannot change it. Both stay off
  until one of the two names them.
- **Liveness and readiness keep their paths.** `/health` and `/ready`
  are what the container uses. `/healthz` and `/readyz` answer the same
  questions; readiness also says the migrations this process knows are
  applied.

## Rejected

- **A second encryption key**, or a required new variable. The instance
  key already exists, and an install that notifies nobody must start
  with the variables it has today.
- **Clear text on a private network.** ADR 0030 refused it. A notifier
  on the administrator's network presents a certificate.
- **Putting secrets in `instance_settings`.** That object is read by
  the screens. The sealed columns are not.
- **Following more than one redirect.** The second hop is a place the
  administrator did not name.

## Consequences

- The daily threshold mail is unchanged. Channels are another way to
  hear the same kinds of failure, as they happen.
- A channel that embeds its credential in the address stores that
  address as a secret. The screen shows that it is set.
- A migration that fails before these tables exist cannot notify.
  One that fails after they exist tries once, then the process exits.
