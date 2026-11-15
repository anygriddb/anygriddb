# Health

Two addresses say whether the process can serve. They stay on when no
notification channel is configured.

## The process

`GET /health` and `GET /healthz` answer `{ "ok": true }` when the process
is up. That is what restarts the container. They do not ask the database.

## Ready to serve

`GET /ready` answers 200 when PostgreSQL answers within two seconds, and
503 otherwise. The body is `{ "ok", "database", "realtime" }`. Realtime
is reported and does not by itself make the process unready: pages
re-read on their own while it reconnects. Compose and a load balancer
keep using `/ready`.

`GET /readyz` is the same check, and also requires every migration this
process knows to be recorded in `schema_migrations`. A process that
started on an older database answers 503 here, with `"migrations": false`.

Neither address asks for a session.

## Administration

Administration, Instance, Health shows the same database check, whether
realtime is listening, the file store, the size of AnyGridDB's own
database, and, when files are on a disk, how full that volume is. An
object store has no volume to measure, and the page says so.

The same page lists the last integration errors: the channel's name, its
provider, and the short reason. The reason is not a secret. The latest
backup the operator recorded is with the other alerts on that page.
