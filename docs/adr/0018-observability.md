# 0018 — Logs, Prometheus metrics, OpenTelemetry off by default

- Status: Accepted
- Date: 2026-11-07

## Decision

- **Logs:** structured JSON through Fastify's pino logger.
- **Metrics:** `/metrics` in Prometheus format (`prom-client`,
  Apache-2.0): requests, latency, jobs, queue depth, connections to each
  external source, and query times per source.
- **Traces:** OpenTelemetry (Apache-2.0), off by default, enabled by the
  operator.
- No telemetry leaves an instance unless its operator turns it on.

## Implementation (2026-11-08)

- `/metrics` answers only a request carrying `METRICS_TOKEN` as a bearer
  token (32 characters at least), compared in constant time; without the
  setting it is 404. It is served on the instance's HTTPS port.
- Requests are labelled by route pattern, built files sharing one label,
  and procedures by name, so series stay bounded. Sources are labelled by
  id and engine.
- Spans are made by hand (requests, procedures, source transactions,
  tasks): the API is ESM, which automatic instrumentation does not reach
  without a loader. The SDK is imported only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and that endpoint must be HTTPS
  beyond the loopback (ADR 0030).
