# Operating AnyGridDB

This guide covers running AnyGridDB with Docker Compose. Every procedure
here was tried on a stack of its own before it was written down.

## Install

Install a release, never `main`: each release is a Git tag `vX.Y.Z`
(ADR 0048). Prefer the published image, pinned by version and digest:

```sh
version=X.Y.Z   # the release to install, from GitHub Releases
files="https://raw.githubusercontent.com/anygriddb/anygriddb/v$version/docker"
mkdir anygriddb && cd anygriddb
curl -fsSLO "$files/compose.yml"
curl -fsSLO "$files/compose.release.yml"
curl -fsSL -o .env "$files/.env.example"
curl -fsSLO "https://github.com/anygriddb/anygriddb/releases/download/v$version/image-pin.env"
# In .env: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, PUBLIC_URL, and
AUTH_ENCRYPTION_KEY="$(openssl rand -base64 32)"   # keep it safe, apart
docker compose -f compose.yml -f compose.release.yml \
  --env-file .env --env-file image-pin.env up -d
```

`image-pin.env`, attached to each release, names the image and its
digest. Give Compose both files: the second one alone would hide `.env`.
On a PostgreSQL of your own (`compose.managed.yml`), build from a
checkout.

To build from a checkout instead:

```sh
git checkout "$(git tag --list 'v*' --sort=-v:refname | head -n 1)"   # the latest release
cd docker
cp .env.example .env
# In .env: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, PUBLIC_URL, and
AUTH_ENCRYPTION_KEY="$(openssl rand -base64 32)"   # keep it safe, apart
../scripts/build-image.sh
docker compose up -d
```

`scripts/build-image.sh` builds the image with the version, commit, and
date it was built from; `docker compose up -d --build` works too, without
the commit.

The stack has four services:

- `certs` runs once and issues PostgreSQL its certificate.
- `postgres-upgrade-check` runs once and refuses to start an empty
  PostgreSQL 18 on top of 17's data.
- `db` is PostgreSQL 18, which only takes connections over TLS.
- `app` is AnyGridDB itself.

AnyGridDB serves HTTPS only on `PUBLIC_URL` (ADR 0029). Without a
certificate of yours, it makes its own authority; its log and
Administration > Health give the fingerprint to check before people
install it.

`AUTH_ENCRYPTION_KEY` seals the sources' passwords, second factors, and
TLS keys. Lose it and they cannot be read again. Change it and they cannot
be read either.

### Encryption at rest

What `AUTH_ENCRYPTION_KEY` seals stays sealed wherever it is copied. The
rows, the change trail, and the files are written as they are: at rest,
they are as safe as the storage they are on. Put the PostgreSQL volume
(`postgres_18`) and the files (the `files` volume, or the bucket) on
encrypted storage, such as an encrypted disk or cloud volume, whose key
is kept apart from the host and its backups.

With files in an S3 service, ask it to encrypt each object it stores:
`S3_SERVER_SIDE_ENCRYPTION=AES256` with the service's own keys, or
`aws:kms` with a key of its key service, `S3_KMS_KEY_ID` (empty: the
bucket's default key). Check first that the service accepts it: one
that does not refuses every upload. A bucket that encrypts every object
by default needs neither.

### Address people open (`PUBLIC_URL`)

`PUBLIC_URL` is the HTTPS origin people type: links in emails, cookies,
API documents, the certificate's primary name, and passkeys. Set it to
that address and open AnyGridDB there. `TLS_NAMES` only adds other names
or IP addresses to the certificate; it does not change the passkey
identity.

| How people reach the instance                                                                               | What works                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Hostname in `PUBLIC_URL` (`https://grid.example.org`, `https://grid.lan:3000`, or `https://localhost:3000`) | HTTPS, TOTP, and passkeys once the authority is installed (or your own certificate is trusted)             |
| IP alone in `PUBLIC_URL` (`https://192.168.1.10:3000`)                                                      | HTTPS and TOTP; passkeys do not (browsers refuse an IP as WebAuthn RP ID). Health and the start log say so |

LAN example with passkeys: give the host a name every workstation resolves
(DNS, mDNS, or `/etc/hosts`), set
`PUBLIC_URL=https://grid.lan:3000`, and put the IP in
`TLS_NAMES=192.168.1.10` so the certificate still covers the address.
People open `https://grid.lan:3000`, install the authority, then enroll a
passkey. Until then, or with an IP-only `PUBLIC_URL`, use a TOTP app.

### Behind a reverse proxy

AnyGridDB serves HTTPS itself. A proxy in front of it must pass the
WebSocket upgrade on `/ws`, and keep an idle connection open for at least
30 seconds (AnyGridDB sends something every 25). Otherwise the app still
works, but changes made by others do not show until a page is read again,
and it says "Connection lost" after 10 seconds.

The client address is the TCP peer. `X-Forwarded-For` is used only when
`ANYGRIDDB_TRUSTED_PROXIES` names that peer: a comma-separated list of IP
addresses or CIDR ranges, such as the Docker network the proxy runs on
(`172.18.0.0/16`). Leave it empty when the API is published directly: a
client cannot choose the address stored in the sign-in trail or used for
rate limits. Behind a proxy that is not named there, every request
carries the proxy's address, and the sign-in rate limit counts everyone
together.

### Offline

AnyGridDB calls no outside service at run time, except when a person
imports an Airtable base (`api.airtable.com` over HTTPS with the token
they give, sealed and dropped when the job ends), or when an
administrator turns on the release check (Health may look up the
latest GitHub Release on demand, and a daily job does the same while
the opt-in stays on). Without internet access, those two fail and say
so; everything else works. On a machine with internet access:

```sh
../scripts/build-image.sh
docker save anygriddb:local postgres:18 | gzip > anygriddb-images.tar.gz
```

Copy that file, `docker/`, and `scripts/` to the target machine, then:

```sh
docker load < anygriddb-images.tar.gz
docker compose up -d          # no --build: the images are there
```

Add `rustfs/rustfs` to the `docker save` command when you use
`compose.s3.yml`.

## Update AnyGridDB

Back up first (below). With the published image, read the release's
notes on GitHub, then take its Compose files and pin:

```sh
version=X.Y.Z   # the release to install
files="https://raw.githubusercontent.com/anygriddb/anygriddb/v$version/docker"
curl -fsSLO "$files/compose.yml"
curl -fsSLO "$files/compose.release.yml"
curl -fsSLO "https://github.com/anygriddb/anygriddb/releases/download/v$version/image-pin.env"
docker compose -f compose.yml -f compose.release.yml \
  --env-file .env --env-file image-pin.env up -d
```

From a repository checkout instead:

```sh
git fetch --tags
git tag -n20 v0.2.0              # the release to install, and its notes
git checkout v0.2.0
scripts/build-image.sh
cd docker && docker compose up -d
```

Read the notes before a release that changes the first number of the
version, or the second before 1.0: it may ask for a step of its own.

Migrations run when AnyGridDB starts, under a lock, so two instances
starting at once do not both migrate.

Administration > Health then shows the version and the commit running.
An administrator may opt in there to check GitHub for a newer release;
the default makes no outbound call. When a newer release is found, a
dismissible notice appears in Administration until that version is
dismissed or the instance is upgraded.
`docker compose exec app anygriddb version` says the same, and so do the
image's labels: `docker compose images app`, then `docker image inspect`
on that image.

## PostgreSQL 17 to 18

The stack runs PostgreSQL 18 on the `postgres_18` volume. PostgreSQL 18
does not open a 17 cluster, and its image keeps its data elsewhere, so an
existing stack's data, in `postgres_data`, must be moved.

Until it is moved, `docker compose up` stops at `postgres-upgrade-check`,
which says so. It never starts an empty database in front of your data.

```sh
scripts/upgrade-postgres.sh
```

The script:

1. stops AnyGridDB;
2. dumps the database with a PostgreSQL 17 of its own, run on the old
   volume without a network;
3. starts PostgreSQL 18 on the new volume and restores the dump;
4. starts AnyGridDB again.

The old volume and the dump stay until you drop them; the script prints
how. To go back to 17, check out the previous compose file. Its volume is
untouched.

## Backups

```sh
scripts/backup.sh
```

This writes one dated folder under `data/backups/` (or `BACKUP_DIR`)
while the stack keeps serving. The folder holds:

- `database.dump`, from `pg_dump` in custom format;
- `files_data.tar.gz`, the attachments, imports, and exports;
- `tls_data.tar.gz`, the instance's authorities, whose keys stay sealed;
- `SHA256SUMS`.

The folder and its files are readable by their owner only. The dump is
not encrypted: emails, names, and cell values are in it, while secrets
sealed with `AUTH_ENCRYPTION_KEY` stay ciphertext because the backup
leaves that key out. Keep the key in another place than the backups,
and encrypt the disk and the archive (age, gpg, or the volume's own
encryption) with a key that does not live on the same host.

Run it from cron, for example nightly:

```cron
15 2 * * * cd /srv/anygriddb && scripts/backup.sh >> data/backups/backup.log 2>&1
```

To restore one, into a stack with the same `AUTH_ENCRYPTION_KEY`:

```sh
scripts/restore.sh data/backups/anygriddb-20261108T021500Z
```

The script checks the sums, stops AnyGridDB, replaces the database, the
files, and the authorities with the backup's, and starts AnyGridDB again.
Try a restore on a spare stack now and then: an untested backup is a
hope.

The scripts take `docker compose` options after their arguments
(`-p name -f compose.yml -f other.yml`) and read `ENV_FILE` instead of
`docker/.env` when it is set.

A base's owner can also save one base, from its settings: a
`.anygriddb.json` file, or a `.anygriddb.zip` archive with its
attachments (ADR 0039), imported again from "Nouvelle base", on this
instance or another. While an archive is written or read, the API keeps
a copy in the system's temporary folder: allow for the largest base's
files there.

## A PostgreSQL of your own

To use a managed service or a server you already run, use
`compose.managed.yml`. It runs AnyGridDB alone:

```sh
# In docker/.env:
DATABASE_URL=postgres://anygriddb:…@pg.example.net:5432/anygriddb?sslmode=verify-full&sslrootcert=/managed-ca/ca.pem
# The provider's certificate authority, if your system does not trust it:
cp provider-ca.pem docker/managed-ca/ca.pem
docker compose -f compose.managed.yml up -d --build
```

- **Version.** PostgreSQL 13 or later is required; 17 or 18 is
  recommended. No extension is needed.
- **TLS.** The address must verify the server's certificate
  (`sslmode=verify-full`). AnyGridDB refuses to start otherwise (ADR 0030).
- **Rights.** The account owns its database. AnyGridDB creates its
  tables and the `graphile_worker` and `ag_sync` schemas there.
- **Connections.** With the default concurrency, one AnyGridDB process
  opens at most about 22 connections: 10 for requests, 10 for background
  work, and 1 to listen for realtime messages. Size the service's limit
  for the processes you run. `DATABASE_POOL_MAX` (4 to 64, 10 by default)
  sets the connections for requests; raise it when
  `anygriddb_db_pool_connections{state="waiting"}` stays above zero.
- **Backups.** Back up with the provider's own tools. `scripts/backup.sh`
  covers the bundled PostgreSQL only; copy `files_data` and `tls_data`
  the same way it does.

## Provisioning with SCIM

An identity provider can create, change, and deactivate accounts, and
keep groups, through SCIM 2.0 (ADR 0038).

1. In **Administration → Provisionnement**, create a token. Copy it at
   once: it is not shown again. It works while its maker is an active
   administrator.
2. In the provider, add a SCIM 2.0 application:
   - **Base URL**: `https://<your address>/scim/v2`, shown on the same
     page.
   - **Authentication**: HTTP header, bearer token: the token.
   - **Okta**: "SCIM 2.0 Test App (Header Auth)". Enable push of new
     users, profile updates, deactivation, and groups. The unique
     identifier is `userName`, an email.
   - **Microsoft Entra ID**: an enterprise application, provisioning
     mode "Automatic", tenant URL the base URL, secret token the token.
     Map `userPrincipalName` or `mail` to `userName`, and `mail` to
     `emails[type eq "work"].value` when they differ.
3. Give each group a role in the settings of the bases it should reach.

What to know:

- Accounts are keyed by email. A provisioned user whose email already
  has an account takes it over.
- Deactivating a user disables the account and ends its sessions;
  deleting it also takes it out of its groups. Its email, display
  name, and history stay, and creating it again brings it back. That
  is not account erasure.
- When someone leaves: disable the account in Administration. Erase
  only when the identity must leave the instance (Settings for the
  person, or Delete on the account in Administration, typing the email:
  an enabled account is disabled first, in the same step). Erase refuses an account still managed by SCIM. A base the
  account alone owns keeps an owner: the person grants one before
  erasing their own account; an administrator types the email of the
  active account that takes those bases, their own if they wish, and
  the bases' audit records it. The only active administrator cannot
  erase their own account. Audit history
  and comments stay under the erased-account placeholder; row values
  still need a manager to trash or edit them.
- The last active administrator cannot be deactivated through SCIM.
- Provisioned people sign in through OIDC or SAML: SCIM sets no
  password.
- Requests count in the API's rate limit, 600 a minute per address.

## Several API processes

A load balancer asks each process `/ready`: it answers 200 while
PostgreSQL answers within two seconds, and 503 otherwise, so requests go
to a process that can serve them. `/health` only says the process is up.

Rate limits are counted in each process's memory. Behind a load balancer,
put the balancer's addresses in `ANYGRIDDB_TRUSTED_PROXIES` so clients are
keyed by their real address, and enforce an overall limit on the proxy as
well: N replicas otherwise multiply every bucket. WebSocket presence is
also per process; fan-out uses PostgreSQL `LISTEN`/`NOTIFY`.

## Supported topology

The supported production shape is **one API process** with the Compose
stack in this repository (or an equivalent single instance against a
managed PostgreSQL).

Several API processes behind a load balancer work for reads and writes,
with these limits:

- **Rate limits** are counted in each process's memory. Put the balancer
  in `ANYGRIDDB_TRUSTED_PROXIES` and enforce an overall limit on the proxy:
  otherwise N replicas multiply every bucket.
- **WebSocket presence** is per process; fan-out still uses PostgreSQL
  `LISTEN`/`NOTIFY`, so other browsers see row changes, but presence and
  some in-memory gates are not shared.

Helm charts and multi-region active-active stay outside this repository.

## Recovery objectives (RPO / RTO)

With the nightly cron example under [Backups](#backups):

| Objective | Typical with the scripts                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO**   | Up to the time since the last successful `scripts/backup.sh` (about 24 hours on the sample cron). Continuous WAL archiving on your PostgreSQL shortens it.     |
| **RTO**   | The time to run `scripts/restore.sh` on a spare host with the same `AUTH_ENCRYPTION_KEY`, plus DNS or load-balancer cutover. Measure it once on a spare stack. |

An untested backup is a hope: restore onto a spare stack after every major
upgrade.

## Shipping logs to a collector

API logs are structured JSON (pino). Point your collector (for example
Grafana Loki via Promtail or Alloy) at the container's stdout. Do not
enable a third-party telemetry SDK inside AnyGridDB; metrics and OTEL stay
opt-in as below.

An error is logged as its kind (`type`), its `code`, the `constraint`
PostgreSQL names, and its `stack`, with the same of its cause. Its message
is left out on purpose, since a message quotes the value that failed (an
address, a row): `message` repeats the kind and the code. To find a
failure, search by `code` and read the first frame of `stack`.

## DSI acceptance checklist

Before opening the instance to users:

1. Install a release image pinned by digest; set `PUBLIC_URL` and
   `AUTH_ENCRYPTION_KEY`; confirm Health shows a trusted certificate path.
2. Put the database and the files on encrypted storage (Encryption at
   rest).
3. Configure SMTP; send a test email from Support. Without email, people
   join only by an invitation's link or an account an administrator
   creates: a sign-up proves its address by a mailed link (ADR 0058).
4. Configure OIDC or SAML; use **Test issuer** / **Test certificate**, then
   complete one real sign-in.
5. Optionally turn on **SSO-only** (administrators keep a password).
6. Optionally set the **sign-in allowlist** and `ANYGRIDDB_TRUSTED_PROXIES`.
7. Create a SCIM token and push one user and one group from the identity
   provider; assign the group a role on a base.
8. Set MFA scope to everyone (or your policy); confirm an enrollment gate.
9. Turn maintenance on briefly; confirm non-admins are signed out.
10. Run `scripts/backup.sh` and `scripts/restore.sh` on a spare stack.
11. If you use a SIEM, save the webhook, send a test event, and confirm it
    arrives with a valid signature.
12. Scrape `/metrics` with `METRICS_TOKEN` over HTTPS.

## Metrics and traces

Both are off until you turn them on (ADR 0018).

- **Metrics.** Set `METRICS_TOKEN` (32 characters or more). Prometheus
  reads `/metrics` on AnyGridDB's HTTPS port with that token:

  ```yaml
  scrape_configs:
    - job_name: anygriddb
      scheme: https
      authorization:
        credentials: "<METRICS_TOKEN>"
      tls_config:
        ca_file: /etc/prometheus/anygriddb-authority.crt # /tls/authority.crt
      static_configs:
        - targets: ["anygriddb.example.net:3000"]
  ```

  Series cover requests by route, tRPC procedures, the pool requests go
  through, transactions and connections in use per client database,
  background tasks, the job queue, failures pages report from browsers,
  and the process. Rules to start from:

  ```yaml
  groups:
    - name: anygriddb
      rules:
        - alert: AnyGridDBServerErrors
          expr: |
            sum(rate(anygriddb_http_requests_total{status="5xx"}[5m]))
              / sum(rate(anygriddb_http_requests_total[5m])) > 0.02
          for: 10m
        - alert: AnyGridDBSlowRequests
          expr: |
            histogram_quantile(0.95, sum by (le)
              (rate(anygriddb_http_request_duration_seconds_bucket[5m]))) > 2
          for: 10m
        - alert: AnyGridDBRequestsWaitForTheDatabase
          expr: anygriddb_db_pool_connections{state="waiting"} > 0
          for: 5m
        - alert: AnyGridDBBackgroundWorkBehind
          expr: anygriddb_queue_jobs{state="ready"} > 1000
          for: 15m
        - alert: AnyGridDBPagesFail
          expr: sum(increase(anygriddb_client_errors_total[15m])) > 5
  ```

- **Traces.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` to your OTLP/HTTP
  collector, over HTTPS. Set `OTEL_EXPORTER_OTLP_HEADERS` for its
  credentials, and `OTEL_SERVICE_NAME` if `anygriddb` does not suit.
  Spans cover requests, the procedures under them, transactions in
  client databases, and background tasks.
