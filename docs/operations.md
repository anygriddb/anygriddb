# Operating AnyGridDB

Runbook for Docker Compose. Procedures were tried on a stack of their own
before they were written down. Assumes Docker Engine, Compose, TLS, and a
collector of your own are known.

| Task                                     | Section                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Install a release                        | [Install](#install)                                                                       |
| Change the encryption key                | [Changing the encryption key](#changing-the-encryption-key)                               |
| Keep files in an S3 store, or move them  | [Where files are kept](#where-files-are-kept)                                             |
| Set `PUBLIC_URL` / TLS                   | [Address people open](#address-people-open-public_url)                                    |
| Run behind a reverse proxy               | [Behind a reverse proxy](#behind-a-reverse-proxy)                                         |
| Get back in as an administrator          | [When no administrator can sign in](#when-no-administrator-can-sign-in)                   |
| Upgrade AnyGridDB                        | [Update AnyGridDB](#update-anygriddb)                                                     |
| Move PostgreSQL 17 → 18                  | [PostgreSQL 17 to 18](#postgresql-17-to-18)                                               |
| Limit an earlier stack's PostgreSQL role | [A stack made before the role was limited](#a-stack-made-before-the-role-was-limited)     |
| Back up and restore                      | [Backups](#backups)                                                                       |
| Use a managed PostgreSQL                 | [A PostgreSQL of your own](#a-postgresql-of-your-own)                                     |
| Provision accounts (SCIM)                | [Provisioning with SCIM](#provisioning-with-scim)                                         |
| Script Administration                    | [The administration API](#the-administration-api)                                         |
| Run several API processes                | [Several API processes](#several-api-processes)                                           |
| See and set the limits                   | [Limits and usage](#limits-and-usage)                                                     |
| Size memory for large reads              | [How much a read may hold](#how-much-a-read-may-hold)                                     |
| Ship logs / metrics                      | [Shipping logs](#shipping-logs-to-a-collector), [Metrics and traces](#metrics-and-traces) |
| Send sign-in events to a collector       | [Sign-in events to a collector](#sign-in-events-to-a-collector)                           |
| Notify when something fails              | [Notifications](integrations/notifications.md)                                            |
| Ping a monitor when a job runs           | [Heartbeats](integrations/heartbeats.md)                                                  |
| Post into a room or Alertmanager         | [Rooms and alerts](integrations/rooms.md)                                                 |
| Scrape Prometheus                        | [Metrics](integrations/metrics.md)                                                        |
| Send errors and traces                   | [Errors and traces](integrations/errors.md)                                               |
| See whether the instance can serve       | [Health](integrations/health.md)                                                          |
| Let an application ask people for access | [Applications (OAuth)](integrations/oauth.md)                                             |
| Acceptance checklist                     | [Acceptance checklist](#acceptance-checklist)                                             |

## Install

Release tag `vX.Y.Z` only, never `main` (ADR 0048). Needs Docker Engine +
Compose plugin (2.26+), `curl`, `openssl`, and a free host port (3000 by
default). Scripts under `scripts/` need a checkout (`git`).

Published image, pinned by version and digest:

```sh
version=X.Y.Z   # the release to install, from GitHub Releases
files="https://raw.githubusercontent.com/anygriddb/anygriddb/v$version/docker"
mkdir anygriddb && cd anygriddb
curl -fsSLO "$files/compose.yml"
curl -fsSLO "$files/compose.release.yml"
curl -fsSL -o .env "$files/.env.example"
curl -fsSLO "https://github.com/anygriddb/anygriddb/releases/download/v$version/image-pin.env"
# .env before first start: POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB,
# PUBLIC_URL, AUTH_ENCRYPTION_KEY (`openssl rand -base64 32`). Keep the key apart.
docker compose -f compose.yml -f compose.release.yml \
  --env-file .env --env-file image-pin.env up -d
```

Further commands in this guide are written as from a checkout's `docker/`.
On an install as above, always pass the release files and pin:

```sh
docker compose -f compose.yml -f compose.release.yml \
  --env-file .env --env-file image-pin.env …
```

Without them Compose builds or starts the wrong image. Extra overlays
(`compose.s3.yml`, `compose.proxy.yml`, `compose.secrets.yml`) are fetched
the same way and added with their own `-f`.

**Product constraints on first start**

- `POSTGRES_PASSWORD`: letters and digits (`openssl rand -hex 24`). `/`, `?`,
  `#` break the DB URL; `%` + two hex digits is URL-decoded. Wrong password
  on empty volumes: `down -v` then `up -d`.
- `POSTGRES_USER`: any name but `postgres` (refused before create).
- First account: one-shot token (ADR 0080), once, one hour:

```sh
docker compose -f compose.yml -f compose.release.yml \
  --env-file .env --env-file image-pin.env exec app anygriddb install-token
```

- Give Compose **both** `.env` and `image-pin.env` (pin alone hides `.env`).
  Image is multi-arch; digest covers both. Verify before install:

```sh
. ./image-pin.env
gh attestation verify "oci://$ANYGRIDDB_IMAGE@$ANYGRIDDB_DIGEST" \
  --repo anygriddb/anygriddb
```

SPDX SBOMs ship per arch on the release
(`anygriddb-amd64.spdx.json`, `anygriddb-arm64.spdx.json`).

Managed PostgreSQL (`compose.managed.yml`): build from a checkout.

From a checkout instead:

```sh
git clone https://github.com/anygriddb/anygriddb.git && cd anygriddb
git checkout "$(git tag --list 'v*' --sort=-v:refname | head -n 1)"
cd docker && cp .env.example .env
# fill POSTGRES_*, PUBLIC_URL, AUTH_ENCRYPTION_KEY
../scripts/build-image.sh
docker compose up -d
```

HTTPS only on `PUBLIC_URL` (ADR 0029). Without your cert, the instance
makes its own authority; fingerprint in the start log and Administration >
Health. `AUTH_ENCRYPTION_KEY` seals source passwords, second factors, and
TLS keys — lose it and they stay closed. Leave disk room under `/tmp` for
the largest upload/import/export/snapshot.

A modified build that must offer its source: set `SOURCE_URL` before build
(shown in About).

### Secrets from files

Any of `DATABASE_URL`, `AUTH_ENCRYPTION_KEY`,
`AUTH_ENCRYPTION_PREVIOUS_KEYS`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`SMTP_PASSWORD`, `OIDC_CLIENT_SECRET`, `METRICS_TOKEN`,
`OTEL_EXPORTER_OTLP_HEADERS` may use `NAME_FILE` instead of `NAME`. Both set
is refused at start. Trailing newline ignored. App user is 1000.

Bundled DB secrets out of `.env`:

```sh
scripts/install.sh
scripts/compose.sh up -d
```

`install.sh` writes `secrets/` beside `.env` and mounts via
`compose.secrets.yml`. `compose.sh`, `backup.sh`, `restore.sh`,
`upgrade-postgres.sh` read the same files. Pass the same `-f` set the stack
runs with.

### Email and single sign-on: Administration, or the environment

SMTP / OIDC / SAML: Administration → Connections after the first account, or
env vars (`SMTP_*`, `OIDC_*`, `SAML_*`, `SAML_TRUST_ADDRESSES`,
`ATTACHMENT_MAX_BYTES`). Environment wins; Administration shows it without
secrets and cannot change it (ADR 0083). Half a config is none.

**SAML address trust.** A first SAML sign-in does not bind an existing
account by address alone unless **This identity provider verifies
addresses** (`SAML_TRUST_ADDRESSES=true`) — only if the provider proves
address changes. Then the address maps to that account (second factor here
still required when set). Bound accounts are found by subject afterwards.
Transient/address NameIDs bind nothing. Email notifies when an existing
account is bound.

**Bindings before 0.4.0** may be address-only; they survive upgrades. Audit:

```sql
SELECT u.email, i.provider, i.issuer, i.subject, i.created_at, i.last_seen_at
FROM sso_identities i JOIN users u ON u.id = i.user_id
WHERE i.provider = 'saml' AND i.created_at > u.created_at
ORDER BY EXISTS (SELECT 1 FROM attributions a WHERE a.user_id = u.id
  AND a.instance_role = 'administrator') DESC, i.created_at;
```

Unlink in Administration, then end sessions.

**Second factor.** Administrators always keep their own factor, even with
**Trust the identity provider's second factor**. Others: provider `amr`/`acr`
or SAML auth class can replace the local factor when that setting is on.

**Sessions.** SAML sessions never outlive `SessionNotOnOrAfter`. Disabling at
the IdP does not end sessions or API tokens here — disable/deprovision here,
or OIDC back-channel logout URL under Connections. Sign-out here leaves the
IdP session for other apps.

**SSO-only** offers to end password sessions and revoke non-admin API tokens.
Last provider and last admin with a password cannot be removed while on.

**SAML cert rotation:** paste new PEM beside old, switch, remove old. OIDC
must sign ID tokens with a published key.

### Encryption at rest

`AUTH_ENCRYPTION_KEY` ciphertext stays sealed wherever copied. Rows, trail,
and files are as safe as their storage: put `postgres_18` and files
(`files` volume or bucket) on encrypted storage with a key kept apart.

S3 object encryption optional: `S3_SERVER_SIDE_ENCRYPTION=AES256` or
`aws:kms` (+ `S3_KMS_KEY_ID`). Service must accept it or uploads fail.

### Changing the encryption key

1. `docker compose exec app anygriddb keys new` → `20261113:Jm0…=`
2. Move old key to `AUTH_ENCRYPTION_PREVIOUS_KEYS` (prefix `0:` if it had no
   id); put new key in `AUTH_ENCRYPTION_KEY`.
3. `docker compose up -d`
4. `docker compose exec app anygriddb keys rotate` then `keys status`
5. When status shows only the new key, drop the old from
   `AUTH_ENCRYPTION_PREVIOUS_KEYS` but keep it with backups made under it.

Backup codes are hashes: tell people to remake them (Account > Security)
before removing the previous key.

### Uploads

Written to system temp, then to the files store — never whole in memory.
`UPLOAD_CONCURRENCY` 1–64 (default 8); over → 503 + `Retry-After`. Public
forms: 30 files/min/address; unclaimed after a day purged hourly (ADR 0062).

### Where files are kept

Default: `files` volume. S3: `compose.s3.yml` (needs `RUSTFS_ACCESS_KEY` /
`RUSTFS_SECRET_KEY`) or `STORAGE_DRIVER=s3` + `S3_*`.

Migrate with both stores configured (`STORAGE_DRIVER` must be `disk` when
S3 vars are set but you still use disk):

```bash
docker compose exec app anygriddb storage migrate --from disk --to s3
# switch STORAGE_DRIVER, up -d, migrate again for files written meanwhile
```

`anygriddb storage sweep [--dry-run]` removes orphan uploads older than a
day. One store per instance; restore DB with files of the same moment.

### When the key does not open the certificates

Authority keys on `tls` are sealed with `AUTH_ENCRYPTION_KEY`. Wrong key →
`certs` or managed `app` exits. Put the sealing key back (or in
`AUTH_ENCRYPTION_PREVIOUS_KEYS`). If lost for good:

```bash
docker compose down
docker compose run --rm certs anygriddb tls reset --yes
docker compose up -d
# managed: run --rm app anygriddb tls reset --yes
```

Workstations and client DBs that trusted the old authority must take the
new one. Sealed DB secrets stay closed.

### Replacing your own certificate

Replace `TLS_CERT_FILE` / `TLS_KEY_FILE` together; reloaded every minute.
Mismatched pair refused (`TLS certificate check failed`); old pair stays.

### Address people open (`PUBLIC_URL`)

HTTPS origin for mail links, cookies, API docs, cert CN, passkeys.
`TLS_NAMES` adds SAN names/IPs only.

| `PUBLIC_URL`                          | Works                                   |
| ------------------------------------- | --------------------------------------- |
| Hostname (`https://grid.example.org`) | HTTPS, TOTP, passkeys (once CA trusted) |
| IP alone                              | HTTPS, TOTP; no passkeys (WebAuthn)     |

LAN + passkeys: name in DNS/`/etc/hosts`, `PUBLIC_URL=https://grid.lan:3000`,
IP in `TLS_NAMES`.

### Behind a reverse proxy

Forward to HTTPS (`https://app:4000` on the stack network, or
`https://127.0.0.1:3000`), upgrade `/ws`, idle ≥ 30 s (ping every 25). Else
live updates stall ("Connection lost" after 10 s).

Loopback-only publish: `compose.proxy.yml`. Set `ANYGRIDDB_TRUSTED_PROXIES`
to the proxy CIDR; empty when published directly. Untrusted proxy → all
clients share one rate-limit/sign-in address.

### Offline

No outbound calls at runtime except Airtable import (token-scoped) and
optional release check (Health / daily job). Offline, those two fail; rest
works.

```sh
../scripts/build-image.sh
docker save anygriddb:local postgres:18 | gzip > anygriddb-images.tar.gz
# copy + docker load; compose up -d (no --build)
```

Add `rustfs/rustfs` when using `compose.s3.yml`.

### Imports / exports / snapshots / restore points

| Limit                 | Default                   | Range          | Notes                                                                       |
| --------------------- | ------------------------- | -------------- | --------------------------------------------------------------------------- |
| Rows an import holds  | 1_000_000                 | 100k–10M       | 256 MiB for CSV and TSV, 64 MiB for Excel, 20 MiB for JSON; file kept ≤ 2 h |
| Rows an export writes | 1_000_000                 | 100k–10M       | export kept 24 h                                                            |
| Snapshot rows         | min of import/export caps | —              | archive ≤ 2 GiB; kept 24 h                                                  |
| Restore points        | 20/base, 30 days (≤ 365)  | Admin Security | live with instance                                                          |

The rows an import holds and an export writes are set in Administration ›
Instance › Limits and usage. `IMPORT_MAX_ROWS` and `EXPORT_MAX_ROWS` fix
them instead, within the same range: the page then shows the environment's
value and offers no field.

Imported snapshot history is not trusted: rows come back as drafts; claimed
status/date refused. Restore points / base&table copies keep dates, authors,
status, comments (ADR 0122); downloaded files do not. Signed rows restore
locked without signature. Points before 0.5.0 → drafts.

### Scripts in automations

Off until Administration → Security allows. Isolated process: no env, no
network, no disk write; max 4 concurrent; 128 MiB process / 64 MiB script;
10 s; share a minute per automation. Calls to URLs leave from the app
(public HTTPS only). Secrets sealed with `AUTH_ENCRYPTION_KEY`.

```bash
docker compose exec app anygriddb scripts check
```

### What takes rows out of a base

Reading rows and taking them out are two permissions (ADR 0129). The four
shipped roles give both **Export** (`data.export`) and **Reach by a token**
(`api.access`); a made role gives them only when ticked, since a permission
a version adds goes to no made role. What is made in someone's name acts by
their roles when it runs: it pauses while they lack what it asks or are
disabled, and is never deleted for it.

| Way out                                                               | Asks of its maker, when made and when used                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A token: REST API, MCP, an application                                | `api.access`, then what each call asks; reading rows: `data.export` too |
| A view's file, a calendar feed, a base's snapshot                     | `data.export` (snapshot: and `base.manage`)                             |
| A view's public link (a form's asks `publish` alone)                  | `publish`, `data.export`                                                |
| A base's public link                                                  | `base.manage`, `publish`, `data.export`                                 |
| A webhook                                                             | `webhooks.manage`, `data.export`                                        |
| An automation that mails, calls, posts, runs a script, or copies rows | `automations.manage`, `data.export` on each table it reads              |
| A table copied with its rows                                          | `schema.manage`, `data.export`, and no field or row rule there          |
| A base copied, or a restore point read back as a new base             | `base.manage`, `data.export`                                            |

Within the reader's own reach on purpose: the grid's copy, a printed row, a
field copied with its values (hidden under column rules until opened), the
application's API console, dashboards, a notification's mail.

## When no administrator can sign in

```sh
docker compose -f compose.yml -f compose.release.yml \
  --env-file .env --env-file image-pin.env exec app \
  anygriddb admin recover --email ada@example.org
```

Prints a one-hour password-set link (ADR 0082). Options:

| Flag                      | When                                                   |
| ------------------------- | ------------------------------------------------------ |
| `--clear-factors`         | Lost second factor                                     |
| `--create "Ada Lovelace"` | No account / SSO-only account needs a password account |
| `--any-address`           | Sign-in address list blocks you (empties it)           |

On the sign-in trail as CLI. Re-run replaces the link only.

## Update AnyGridDB

Back up first. Published image:

```sh
version=X.Y.Z
files="https://raw.githubusercontent.com/anygriddb/anygriddb/v$version/docker"
curl -fsSLO "$files/compose.yml"
curl -fsSLO "$files/compose.release.yml"
curl -fsSLO "https://github.com/anygriddb/anygriddb/releases/download/v$version/image-pin.env"
docker compose -f compose.yml -f compose.release.yml \
  --env-file .env --env-file image-pin.env up -d
```

Checkout: `git checkout v$version` → `scripts/build-image.sh` → `compose up -d`.

Read notes before major (or minor before 1.0). Migrations run in one-shot
`prepare` under a lock; failure → app does not start
(`docker compose logs prepare`). A release that needs a pre-step refuses
with "Upgrade refused" and changes nothing (ADR 0106): start the previous
version, do the step, upgrade again. When the refusal says what the upgrade
would change and that it may be accepted (0.12.0, where roles add up: ADR
0131), read it, then set `ANYGRIDDB_ACCEPT_UPGRADE` in `.env` to the
migration it names (`0150`; several by commas) and start again; remove it
once the upgrade has run.

Version: Administration → Health, or
`docker compose exec app anygriddb version`.

### Links of rows already in the trash

Rows trashed before link recovery existed come back without one-to-many
keys. Once after upgrade:

```bash
docker compose exec app anygriddb trash recover-links --dry-run
docker compose exec app anygriddb trash recover-links
```

Adds trail entries only; idempotent; skips locked/signed since.

## The application's database role

Compose: `POSTGRES_USER` owns tables — only `prepare` uses it. App signs
in as `anygriddb_app` (password on `service_certs`, no table ownership).
That role cannot rewrite trails or locked/signed values.

Stolen app credentials can still forge events/signatures, unlock, drop
tables, erase accounts, or purge past a year — each leaves an irremovable
event. Ship the sign-in trail out, keep backups out of reach, guard
`POSTGRES_PASSWORD`.

If `prepare` stops on `role "anygriddb_app" does not exist` (seen 0.7.0–0.7.4
with object-store overlay):

```sh
docker compose restart db
docker compose up -d
```

Missing file-field index (pre-0.4.1 / interrupted build): named in start log;
`docker compose run --rm indexes`.

## A stack made before the role was limited

Older volumes may still have `POSTGRES_USER` as superuser (warning in log /
Health). Check:

```sh
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "select rolsuper from pg_roles where rolname = current_user"
```

`t` → migrate: backup, stop, remove `<project>_postgres_18` only, start,
restore.

## PostgreSQL 17 to 18

Data lives on `postgres_18`. Unmoved 17 data (`postgres_data`) →
`postgres-upgrade-check` stops the stack (never starts empty over data).

```sh
scripts/upgrade-postgres.sh
```

Stops app → dump with PG17 on old volume → restore to PG18 → start app.
Old volume and dump kept until you drop them.

## Backups

```sh
scripts/backup.sh
```

Writes `data/backups/<dated>/`: `database.dump`, `files_data.tar.gz`,
`tls_data.tar.gz`, optional `rustfs_data.tar.gz`, `SHA256SUMS`. External S3
is not included (script says so). Failed/stopped runs leave no partial
folder. Owner-only perms. `AUTH_ENCRYPTION_KEY` is **not** in the backup —
keep it elsewhere. The instance keeps serving: the database is dumped
first, so a file sent while the files are copied is one it does not name
yet, which the next backup keeps.

Optional [age](https://age-encryption.org) encryption:

```sh
# docker/.env
BACKUP_AGE_RECIPIENT=age1…
BACKUP_KEEP_DAYS=30   # optional; this stack's folders only
```

```cron
15 2 * * * cd /srv/anygriddb && scripts/backup.sh >> data/backups/backup.log 2>&1
```

Health shows last runs; admins alerted after failure or 36 h without success
(configurable). External backups can report:

```sh
docker compose exec app anygriddb backups record \
  --name nightly-2026-11-13 --started 2026-11-13T02:15:00Z
```

Restore (same `AUTH_ENCRYPTION_KEY`):

```sh
scripts/restore.sh data/backups/anygriddb-20261108T021500Z
BACKUP_AGE_IDENTITY=/path/to/anygriddb-backup.key \
  scripts/restore.sh data/backups/anygriddb-20261108T021500Z
```

Checks sums → decrypt → room for two copies → restore to temp DB →
`keys status` → cut over; previous data removed only when healthy. Exit 3 =
key mismatch, 4 = no room, 1 = other. `--in-place` when disk cannot hold two
copies (failure not undoable). `--keep-store-files` for backups without
object-store files. `RESTORE_START_SECONDS` default 600.

Pass the same `-f` / `ENV_FILE` the stack uses. Published-image installs:
checkout the tag beside the install and point scripts at its compose files
(see script headers).

Per-base export: Settings → `.anygriddb.json` / `.anygriddb.zip` (ADR 0039).

## A PostgreSQL of your own

```sh
# docker/.env
DATABASE_URL=postgres://anygriddb:…@pg.example.net:5432/anygriddb?sslmode=verify-full&sslrootcert=/managed-ca/ca.pem
mkdir -p docker/managed-ca && cp provider-ca.pem docker/managed-ca/ca.pem
docker compose -f compose.managed.yml up -d --build
```

- PostgreSQL ≥ 16 (17/18 recommended); no extension.
- TLS: `sslmode=verify-full` (or `verify-ca` / `require` / `ssl=true`
  without `uselibpqcompat=true`). Refused otherwise (ADR 0030).
- Account owns the DB; creates tables + `graphile_worker` / `ag_sync`. Alone
  it signs the app in as table owner (warned in log/Health).
- ~22 connections per process default (`DATABASE_POOL_MAX` 4–64, default 10).
- Backups: provider tools + copy `files_data` / `tls_data` yourself.

### A role of its own for the application

Once, as server admin (replace `anygriddb` with the owner role):

```sql
CREATE ROLE anygriddb_app LOGIN PASSWORD '…'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT anygriddb_app TO anygriddb WITH INHERIT FALSE, SET TRUE;
```

Before each new version, migrate as owner:

```sh
read -rs DATABASE_URL && export DATABASE_URL
docker compose -f compose.managed.yml run --rm --no-deps -T \
  -e DATABASE_URL app anygriddb database prepare
unset DATABASE_URL
```

Then `.env` `DATABASE_URL` is `anygriddb_app`. App refuses start until
`prepare` ran.

## Provisioning with SCIM

1. Administration → People → Provisioning (SCIM): create token (shown once;
   works while maker is active admin).
2. IdP SCIM 2.0 app: base `https://<address>/scim/v2`, bearer token.
   Okta: "SCIM 2.0 Test App (Header Auth)", push users/groups,
   `userName` = email. Entra: Automatic provisioning; map UPN/mail →
   `userName` / `emails[type eq "work"].value`.
3. Assign groups roles on bases (or Administration → People → Groups).

- Accounts keyed by email; provisioned user takes existing account.
- Local groups (ADR 0070) are invisible to IdP; same name → refused.
- Deactivate ≠ erase. Erase refuses SCIM-managed accounts; last active
  admin cannot deactivate via SCIM or erase self.
- SCIM sets no password (OIDC/SAML sign-in). Rate limit 600/min/address.

## The administration API

ADR 0086. Token under Administration → Connections → Administration API
(name, TTL, scopes `accounts` / `invitations` / `settings`; proof required
to create). OpenAPI: `/api/v1/admin/openapi.json` (no token).

```bash
curl -sS -X PATCH https://<address>/api/v1/admin/settings \
  -H "Authorization: Bearer $ANYGRIDDB_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"maintenance": true, "banner": "Back at noon"}'
```

Token dies with maker's admin role; trails under their name. Cannot do
proof-guarded acts; new accounts are never admins / have no base role.
Writable settings: `maintenance`, `banner`, `defaultLocale`,
`attachmentMaxBytes`, `releaseCheck`, alert thresholds, map tiles. Env-held
settings refused. Base/API/SCIM tokens and sessions do not open this API.
Rate limit 600/min/address.

## Several API processes

Supported shape: **one** API process. Multiple behind a balancer:

- Rate limits are counted in PostgreSQL, so they hold across processes. Set
  `ANYGRIDDB_TRUSTED_PROXIES` so each client is counted by its own address.
- WebSocket presence per process; row fan-out via `LISTEN`/`NOTIFY`.

Balancer: `/ready` (Postgres ≤ 2 s) / `/readyz` (+ migrations). `/health` /
`/healthz` = process up. See [Health](integrations/health.md).

## Limits and usage

Administration › Instance › **Limits and usage** lists every limit the
instance keeps, where it is set (AnyGridDB, the environment, Settings),
and what is used of it where it is counted: for each kind of request,
the most one address sent over this minute and the one before, and how
many addresses were refused; for jobs, the most one account holds. Counts
only, never an address or an account.

The requests a minute, per address, are set there, each between a floor
that still protects the instance and a top that still protects the
database; a limit left at its shipped value follows a later version's.
Every process reads a change within five seconds. Raise one when many
people share an address (an office behind one proxy, with
`ANYGRIDDB_TRUSTED_PROXIES` set). The sign-in trail says who changed the
limits; the log line `limits changed` holds the values before and after.

## How much a read may hold

≤ 64 MiB rows per request; ≤ ¼ heap for all reads (ADR 0110).
Over → `page_too_large` (400) or `reads_busy` (503). Client gone →
`request_closed` (499) at info. Exports/snapshots/automations not counted.

## Recovery objectives (RPO / RTO)

| Objective | With the scripts                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------ |
| **RPO**   | Time since last successful `scripts/backup.sh` (~24 h on sample cron); WAL archiving shortens it |
| **RTO**   | `scripts/restore.sh` on a spare + DNS/LB cutover; measure once                                   |

Restore onto a spare after every major upgrade.

## Shipping logs to a collector

JSON on stdout (pino). Point your collector at it. No third-party SDK;
metrics/OTEL opt-in below.

Errors log `type`, `code`, PostgreSQL `constraint`, `stack` — not the
message (it may quote values). Search by `code`. Administration → Instance
→ Logs keeps recent lines in process memory (ADR 0087); full history is
stdout.

## Sign-in events to a collector

Failed sign-ins, locks, account/role/settings/token events: ids and codes,
never email/secret.

- **HTTPS webhook** (ADR 0056): Administration → Connections.
- **Syslog over TLS** RFC 5425 (ADR 0084): host/port (default 6514), optional
  CA PEM. Private nets need Notifications allow-list; loopback/cloud
  metadata never accepted (ADR 0105). Or pin in env (wins, ADR 0083):

```sh
SYSLOG_HOST=logs.internal
SYSLOG_PORT=6514
SYSLOG_CA_FILE=/run/secrets/syslog_ca
```

Facility `local0`, app `anygriddb`, msgid `auth`; queued and retried. No
cleartext.

## The change trail to a collector

DB trail is rewritable by the table-owning role. Administration → Security →
Change trail → **Send to the collectors** ships batches (ADRs 0120, 0121):
metadata only, ≤ 25 events / ≤ 8 KiB syslog msgid `trail`, chained digests.
Needs indexes: `docker compose run --rm indexes` when the app does not own
tables. Admin shows last batch / waiting count (caps at 100k).

```sh
docker compose exec -T app anygriddb trail verify < trail.jsonl
```

Exit 0 = intact; 1 = tampered/missing/duplicate contents. Keep previous keys
in `AUTH_ENCRYPTION_PREVIOUS_KEYS` for older batches. ~24 B/event in memory.

## Metrics and traces

Off until enabled (ADR 0018).

**Metrics.** `METRICS_TOKEN` (≥ 32 chars) or Administration → Connections →
Notifications (env wins). Without token, `/metrics` → 404.

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

| Series                                                                                 | Meaning                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------- |
| `anygriddb_http_requests_total`, `anygriddb_http_request_duration_seconds`             | HTTP by route                                 |
| `anygriddb_trpc_procedure_duration_seconds`                                            | tRPC by procedure/outcome                     |
| `anygriddb_db_pool_connections`                                                        | pool open/idle/waiting                        |
| `anygriddb_db_query_duration_seconds`                                                  | own-DB query time (no statement label)        |
| `anygriddb_database_size_bytes` / `_reachable`                                         | size; 0 if DB down (`/metrics` still answers) |
| `anygriddb_source_operation_duration_seconds`, `anygriddb_source_operations_in_flight` | client-DB ops                                 |
| `anygriddb_job_duration_seconds` / `anygriddb_queue_jobs`                              | jobs                                          |
| `anygriddb_client_errors_total`                                                        | browser-reported failures                     |
| `anygriddb_websocket_connections`, `anygriddb_websocket_refused_total`                 | sockets / refusals                            |
| `anygriddb_automation_scripts_total`, `anygriddb_automation_runs_paced_total`          | scripts / pacing                              |
| `anygriddb_acting_as_total` / `anygriddb_build_info`                                   | acting-as / version                           |
| `anygriddb_undeclared_permission_total`                                                | a check its way in did not declare: report it |

Plus process/node defaults. Starter alerts:

```yaml
groups:
  - name: anygriddb
    rules:
      - alert: AnyGridDBDown
        expr: up{job="anygriddb"} == 0
        for: 2m
      - alert: AnyGridDBDatabaseUnreachable
        expr: anygriddb_database_reachable == 0
        for: 1m
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

**Traces.** `OTEL_EXPORTER_OTLP_ENDPOINT` (HTTPS) + optional
`OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_SERVICE_NAME`. Or save under
Notifications. See [Errors and traces](integrations/errors.md).

## Acceptance checklist

Before opening the instance to users:

1. Release image pinned by digest; `PUBLIC_URL` + `AUTH_ENCRYPTION_KEY`; Health shows trusted cert path.
2. DB + files on encrypted storage.
3. SMTP test from Support (or invite/admin-created accounts only).
4. OIDC or SAML: Test issuer/certificate, then one real sign-in.
5. Optional SSO-only (admins keep a password).
6. Optional sign-in addresses + `ANYGRIDDB_TRUSTED_PROXIES`.
7. SCIM: push one user + group; assign a base role.
8. MFA scope; confirm enrollment gate.
9. Maintenance on briefly; non-admins signed out.
10. `scripts/backup.sh` + `scripts/restore.sh` on a spare.
11. SIEM webhook or syslog: test event arrives.
12. Scrape `/metrics` with `METRICS_TOKEN` over HTTPS.
