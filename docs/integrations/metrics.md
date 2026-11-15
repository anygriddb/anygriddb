# Metrics

`GET /metrics` is Prometheus text. It answers 404 until a token is set,
and 401 when the bearer does not match.

Set `METRICS_TOKEN` (32 characters or more) in the environment, or save
a token under Administration, Connections, Notifications. The
environment wins when it is set (ADR 0083). The saved token is not
shown again. Leave the field blank to keep it. A restart is not
required.

Prometheus reads the HTTPS port:

```yaml
scrape_configs:
  - job_name: anygriddb
    scheme: https
    authorization:
      credentials: "<METRICS_TOKEN>"
    tls_config:
      ca_file: /etc/prometheus/anygriddb-authority.crt
    static_configs:
      - targets: ["anygriddb.example.net:3000"]
```

The series already described in [operations](../operations.md#metrics-and-traces)
stay as they are. Three more are added there:

- `anygriddb_db_query_duration_seconds` is how long one query on
  AnyGridDB's own database took. The statement is not a label.
- `anygriddb_database_size_bytes` is `pg_database_size` of that database.
- `anygriddb_websocket_connections` is how many browser sockets this
  process has open.
