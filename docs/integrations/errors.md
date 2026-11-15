# Errors and traces

Both are off until an administrator turns one on, under Administration,
Connections, Notifications. Nothing new is required in the environment.
What the environment already sets still wins (ADR 0083).

## Errors

Paste a Sentry-compatible DSN, for example
`https://publickey@errors.example.com/12`. AnyGridDB POSTs one envelope
to `{scheme}://{host}/api/{project}/envelope/` with `X-Sentry-Auth`.
There is no SDK and no restart.

The envelope is sent for an internal server error and for a background
job that failed. It says that an internal error happened. It does not
include a cookie, an authorization header, an address, or a row.

Send a test from the same page to confirm the store accepted one
envelope.

## Traces

Set the collector's HTTPS address, for example
`https://collector.example.com`. Spans are posted to
`{endpoint}/v1/traces`. Headers, when the collector wants them, are
`k=v,k2=v2`. They are a secret.

Saving replaces the exporter that is running. The page says that traces
are being sent. If the process cannot replace the exporter, the page
says to restart before the new address is used.

`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`, when
set, are what the process uses. The page then shows that the
environment holds them, and a value saved here is not used.
