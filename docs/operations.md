# Operating AnyGridDB

This guide covers running AnyGridDB with Docker Compose. Every procedure
here was tried on a stack of its own before it was written down.

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
# In .env, before the first start: POSTGRES_USER, POSTGRES_PASSWORD,
# POSTGRES_DB, PUBLIC_URL, and AUTH_ENCRYPTION_KEY, which is what
# `openssl rand -base64 32` prints. Keep that key safe, apart.
docker compose -f compose.yml -f compose.release.yml \
  --env-file .env --env-file image-pin.env up -d
```

Choose `POSTGRES_PASSWORD` before the first start, of letters and
digits (`openssl rand -hex 24`). It is written into the database's
address, where a `/`, `?`, `#` or `%` would be read as part of the
address: AnyGridDB then says so and does not start. The database keeps
the password it was made with, so on an install that holds nothing yet,
start again on empty volumes: the same command with `down -v`, then
`up -d`.

The instance has no account yet. Its first account administers it, and
is made with a token that only this command gives, to this terminal and
nowhere else (ADR 0080). It works once, for an hour; asking again
replaces it:

```sh
docker compose -f compose.yml -f compose.release.yml \
  --env-file .env --env-file image-pin.env exec app anygriddb install-token
```

Open `PUBLIC_URL`, create the account, and type the token where the form
asks for it.

`image-pin.env`, attached to each release, names the image and its
digest. Give Compose both files: the second one alone would hide `.env`.
The image is published for `linux/amd64` and `linux/arm64`: the digest
names both, and Docker pulls the one of the host. To check that it is the
one this repository's Release workflow built, from which commit, before
installing it (GitHub CLI):

```sh
. ./image-pin.env
gh attestation verify "oci://$ANYGRIDDB_IMAGE@$ANYGRIDDB_DIGEST" \
  --repo anygriddb/anygriddb
```

Each release also lists the packages its images hold, in SPDX, one file
per architecture (`anygriddb-amd64.spdx.json`,
`anygriddb-arm64.spdx.json`): the system's and Node.js's, for a scanner
or an inventory of your own.

On a PostgreSQL of your own (`compose.managed.yml`), build from a
checkout.

To build from a checkout instead:

```sh
git checkout "$(git tag --list 'v*' --sort=-v:refname | head -n 1)"   # the latest release
cd docker
cp .env.example .env
# In .env, before the first start: POSTGRES_USER, POSTGRES_PASSWORD,
# POSTGRES_DB, PUBLIC_URL, and AUTH_ENCRYPTION_KEY, which is what
# `openssl rand -base64 32` prints. Keep that key safe, apart.
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
  AnyGridDB signs in as `POSTGRES_USER`, a role that owns its database
  and is no superuser; the cluster's superuser is `postgres`, which
  nothing uses once the volume is made.
- `app` is AnyGridDB itself.

Each container takes no new privilege, drops every Linux capability but
the few its start needs, and keeps its log to three files of 10 MB.
AnyGridDB's image is read-only: what the instance keeps is on its
volumes, and what comes in or goes out (an upload, an import, an export,
a snapshot) is written whole to `/tmp` on its way, a volume of its own
on the host's disk, emptied when the container is replaced. Leave the
disk room for the largest file the instance takes in or gives out.

AnyGridDB serves HTTPS only on `PUBLIC_URL` (ADR 0029). Without a
certificate of yours, it makes its own authority; its log and
Administration > Health give the fingerprint to check before people
install it.

"About AnyGridDB", in the account menu, on the sign-in page and on
public links' pages, shows
the license, that the software comes without warranty, where its source
is, and the licenses of the libraries it is built with
(`/license.txt`, `/third-party-licenses.txt`). The license asks whoever
runs a version they changed to offer its source to the people who use
it: name your repository in `SOURCE_URL`
(`apps/web/components/shell/about-dialog.tsx`) before you build.

`AUTH_ENCRYPTION_KEY` seals the sources' passwords, second factors, and
TLS keys. Lose it and they cannot be read again. To change it, follow
"Changing the encryption key" below: changed alone, it opens nothing of
what the earlier key sealed.

### Secrets from files

Each secret AnyGridDB reads from its environment can come from a file
instead: set `NAME_FILE` to the file's path in the container, and leave
`NAME` unset. That is how a container's secret store hands a value over
(Docker and Podman secrets under `/run/secrets`, a Kubernetes secret
mounted as a volume), and it keeps the value out of `docker inspect`
and of the process's environment. It holds for `DATABASE_URL`,
`AUTH_ENCRYPTION_KEY`, `AUTH_ENCRYPTION_PREVIOUS_KEYS`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `SMTP_PASSWORD`, `OIDC_CLIENT_SECRET`, `METRICS_TOKEN`,
and `OTEL_EXPORTER_OTLP_HEADERS`, for the application and for the
`anygriddb` commands alike. A line break at the file's end is ignored.
Setting both `NAME` and `NAME_FILE` is refused at start: one of them
would be ignored without a word.

With the database this stack runs, the two secrets `compose.yml` needs,
`POSTGRES_PASSWORD` and `AUTH_ENCRYPTION_KEY`, can leave `.env` too:

```sh
scripts/install.sh            # docker/ of this checkout, or a folder named
scripts/compose.sh up -d      # every compose command goes through it
```

`scripts/install.sh` keeps each in a file of `secrets/`, beside `.env`
(the folder is the owner's alone; PostgreSQL and the application read
their files as accounts of their own, inside their containers), and the
database's address made from the password. On an install that already
runs, it moves the values `.env` holds into their files, as Compose reads
them: a new key would leave everything sealed with the old one unread. It
changes nothing when the folder has no `compose.secrets.yml`, or when the
password would not open the database of a stack running from that folder.
Run again, it changes nothing. `scripts/compose.sh` reads the files so Compose can fill
`compose.yml` in, which still refuses to start without them, and adds
`compose.secrets.yml`, which mounts the files and leaves the variables
empty in the containers: `docker inspect` shows neither. Options before
the command go to `docker compose` after those two files
(`scripts/compose.sh -f compose.release.yml --env-file image-pin.env up -d`).
`scripts/backup.sh`, `scripts/restore.sh` and
`scripts/upgrade-postgres.sh` read the same files: give them
`-f compose.yml -f compose.secrets.yml` and the other files the stack runs
with. All of them read `.env` through Compose, so a value means there what
it means to Compose, a variable set in the shell wins over the file, and
nothing in the file is ever run. On a PostgreSQL of your own, `DATABASE_URL` is handed over as below.

The other secrets (`S3_ACCESS_KEY` and `S3_SECRET_KEY` of a store of your
own, `METRICS_TOKEN`, `OTEL_EXPORTER_OTLP_HEADERS`, `DATABASE_URL` on a
PostgreSQL of your own) can come from a file through a Compose file of
your own, given after the others, that mounts the file and names it. The
application runs as user 1000, who must be able to read it:

```yaml
# compose.local-secrets.yml
services:
  app:
    environment:
      METRICS_TOKEN_FILE: /run/secrets/metrics_token
    secrets:
      - metrics_token

secrets:
  metrics_token:
    file: ./metrics_token
```

### Email and single sign-on: Administration, or the environment

Email (SMTP) and single sign-on (OIDC, SAML) are set in Administration,
Connections, once the first account exists. To hold them where the
instance is installed instead, give the application their variables
through a Compose file of your own: `SMTP_HOST` and `SMTP_FROM`, with
`SMTP_PORT`, `SMTP_USER` and `SMTP_PASSWORD`; the four `OIDC_*`; the four
`SAML_*`, with `SAML_TRUST_ADDRESSES`. What the environment sets wins:
Administration shows it, without its secrets, and cannot change it (ADR
0083). Half a configuration there is none, and Administration's applies.
The same holds for `ATTACHMENT_MAX_BYTES`, the largest attachment.

A SAML assertion does not say whether its address was verified, so a first
sign-in through SAML does not reach an account that already exists. Turn on
**This identity provider verifies addresses** (`SAML_TRUST_ADDRESSES=true`)
only if nobody can change their address at the provider without proving it:
with it, whoever holds an address there signs in as the account of that
address, unless the account has a second factor here, which they must prove
first. An account already bound to a persistent NameID is not concerned.

Once bound, an account is found by the provider's subject, whatever address
the provider sends later. A first sign-in never reaches an account another
subject holds. On an account with a second factor of its own, it asks for that
factor whatever the setting below says, and binds only once it is proved. The
person is told by email when an account that existed is bound. A provider that
sends no lasting subject (a transient or address NameID) binds nothing: such an
account is asked for its factor at every sign-in.

**Review the bindings made before 0.4.0.** Until then a first SAML sign-in
could bind an existing account by its address alone, and a binding survives an
upgrade. Nothing removes them, since that would sign out legitimate people.
List what was bound to accounts older than their binding, and check each
against your provider:

```sql
SELECT u.email, i.provider, i.issuer, i.subject, i.created_at, i.last_seen_at
FROM sso_identities i JOIN users u ON u.id = i.user_id
WHERE i.provider = 'saml' AND i.created_at > u.created_at
ORDER BY u.is_admin DESC, i.created_at;
```

To undo one, use **Unlink single sign-on** on the account's page in
Administration, then end its sessions.

**Second factor.** An administrator always keeps a factor of their own, even
with **Trust the identity provider's second factor**: one who signs in through
the provider without one is asked to enrol it. For anyone else, a provider that
says it asked a single factor (OIDC `amr` or `acr`, the SAML authentication
class) does not replace the factor the account has here.

**How long a session lasts.** A session never outlives the
`SessionNotOnOrAfter` of the SAML assertion that opened it. Disabling someone
at the provider does not by itself end a session open here, nor their API
tokens. To cut access at once, disable the account here, or deprovision it with
SCIM. With OIDC, give the provider this instance's **Back-channel logout URL**
(shown under Connections): ending the person's sessions at the provider then
ends them here. A provider may send nothing when a person is only disabled, so
end their sessions there too. Signing out here leaves the provider's session
open, for the person's other applications; the next sign-on from that browser
asks the provider to authenticate them again.

**Single sign-on only.** Turning it on offers to end the sessions opened with a
password and to revoke the API tokens of everyone but administrators. Scripts
that use those tokens stop working, so it is your choice. While it is on, the
last provider and the last administrator with a password cannot be removed.

**Rotating a SAML certificate.** The certificate field takes several PEM
certificates: paste the new one beside the old one, switch the provider, then
remove the old one. An OIDC provider must sign its ID tokens with a key it
publishes.

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

### Changing the encryption key

Change the key when it may have been read by someone who should not hold
it, or on the schedule your policy sets. Nothing is lost on the way: the
earlier key stays beside the new one until everything it sealed has been
sealed again.

1. Make a new key. It comes with an identifier, today's date unless you
   give one:

   ```bash
   docker compose exec app anygriddb keys new
   # 20261113:Jm0…=
   ```

2. In `docker/.env`, move the key in use to `AUTH_ENCRYPTION_PREVIOUS_KEYS`,
   with its identifier in front, and put the new one in its place. A key
   that was given without an identifier is named `0`:

   ```
   AUTH_ENCRYPTION_KEY=20261113:Jm0…=
   AUTH_ENCRYPTION_PREVIOUS_KEYS=0:the-key-in-use-until-now=
   ```

3. Start the stack again (`docker compose up -d`). Everything still opens,
   what is sealed from now on is sealed with the new key, and the keys of
   the stack's certificates are sealed again with it at this start.

4. Seal again what the earlier key sealed, then check that nothing is left
   under it:

   ```bash
   docker compose exec app anygriddb keys rotate
   docker compose exec app anygriddb keys status
   ```

   `rotate` can be run again at any time, beside the running instance. If
   it names values no key opens, a key is missing from
   `AUTH_ENCRYPTION_PREVIOUS_KEYS`: add it and run the command again.

5. Once `status` shows only the new key, the earlier one can leave
   `AUTH_ENCRYPTION_PREVIOUS_KEYS`. Keep it with the backups made while it
   was in use: a backup restored later holds what that key sealed, and
   needs it beside the current one.

Backup codes are stored as hashes under the key, so they cannot be sealed
again: the codes people made before the change work while the earlier key
is kept, and stop once it is removed. Tell people to make new ones first
(Account > Security). A sign-in under way and a queued import's token,
which live minutes, are not rewritten either.

### Uploads

An attachment, a file to import, or a base snapshot is written to the
system's temporary folder as it arrives, checked there, then copied to
the files' store: the process never holds a file whole in memory. Leave
room in that folder for as many of the largest files as are sent at
once. `UPLOAD_CONCURRENCY` (1 to 64, 8 by default) caps how many each
process reads at once; one more is refused with 503 and `Retry-After`,
and people are told to try again in a moment.

A public form takes files from people without an account: each counts
in the files' store as soon as it is sent, 30 a minute at most per
address. One that no answer claims within a day is removed by the hourly
purge (ADR 0062).

### Where files are kept

Files live on the `files` volume. To keep them in an S3-compatible store
instead, start the stack with `compose.s3.yml`, which adds RustFS
(`docker compose -f compose.yml -f compose.s3.yml up -d`), or set
`STORAGE_DRIVER=s3` and the `S3_*` values of a service of your own.

To move an instance's files from one to the other, with both stores
set in the environment and `STORAGE_DRIVER` naming the one in use
(`disk` must be written: with `S3_*` set and no driver, the instance
uses S3):

1. Copy every file the target lacks. Nothing is deleted, and
   `--dry-run` counts first:

   ```bash
   docker compose exec app anygriddb storage migrate --from disk --to s3
   ```

2. Switch `STORAGE_DRIVER` and start the stack again.
3. Run the command again, for the files written meanwhile.

A file is stored before the row that names it, so an upload that died
on the way leaves a file no row names. A daily sweep deletes those
older than a day: `anygriddb storage sweep --dry-run` lists what it
would delete, and without the flag deletes them now. A folder or a
bucket therefore belongs to one instance, and a database restored from
a backup comes with the files of the same moment.

### Address people open (`PUBLIC_URL`)

`PUBLIC_URL` is the HTTPS origin people type: links in emails, cookies,
API documents, the certificate's primary name, and passkeys. Set it to
that address and open AnyGridDB there. `TLS_NAMES` only adds other names
or IP addresses to the certificate; it does not change the passkey
identity. A change made from a page at another address than `PUBLIC_URL`
is taken only when that address is the one the request reached AnyGridDB
under: behind a proxy that forwards under another name, people open
`PUBLIC_URL`.

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

AnyGridDB serves HTTPS itself. A proxy in front of it must forward to
HTTPS (to `https://app:4000` on the stack network, or
`https://127.0.0.1:3000` on the host), pass the WebSocket upgrade on
`/ws`, and keep an idle connection open for at least 30 seconds
(AnyGridDB sends something every 25). Otherwise the app still works, but
changes made by others do not show until a page is read again, and it
says "Connection lost" after 10 seconds.

On the same host, publish only the loopback so the proxy alone is
reachable from other machines:

```sh
docker compose -f compose.yml -f compose.proxy.yml up -d
```

Set `ANYGRIDDB_TRUSTED_PROXIES` in `.env` to the proxy's address or its
Docker network (for example `172.18.0.0/16`). The client address is the
TCP peer; `X-Forwarded-For` is used only when that peer is named there.
Leave it empty when the API is published directly: a client cannot
choose the address stored in the sign-in trail or used for rate limits.
Behind a proxy that is not named there, every request carries the
proxy's address, and the sign-in rate limit counts everyone together.

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

### Imports

An uploaded file is written to the system's temporary folder as it
arrives (256 MB for CSV and TSV, 64 MB for Excel, 20 MB for JSON), read
once for its columns and its row count, then kept in the files' store
until its import runs, at most two hours. The import job copies it back
to the temporary folder and writes its rows as it reads them, 500 at a
time. `IMPORT_MAX_ROWS` (100,000 to 10,000,000, 1,000,000 by default) is
the most rows one file may hold: a larger one is refused when it is
uploaded, before anything is kept. Leave room in the temporary folder
for the largest file, once per upload and once per import running at
once (`UPLOAD_CONCURRENCY`, `JOB_CONCURRENCY`).

### Scripts in automations

Off until an administrator allows them (Administration, Security). A
script never runs in the application's process: each automation run
that holds one starts a process of its own, which reads its own code
and nothing else, writes nowhere, opens no connection, and is given
nothing of the environment. Four scripts run at once at most, the
others wait; each may take 128 MiB of memory for its process and 64 MiB
for the script itself, and is ended after 10 seconds; the scripts of
one automation run share a minute. Leave the
container that much memory beside what the application uses, or leave
scripts off.

A script's calls to addresses leave from the application, never from
the script's process, and only to public HTTPS addresses, as webhooks
do: an instance with no way out makes none. The secrets those calls
carry are sealed with `AUTH_ENCRYPTION_KEY`, and `anygriddb keys rotate`
seals them again with the rest.

Where the instance is installed must let that process start. This says
whether it does, without reading or writing anything of the instance:

```bash
docker compose exec app anygriddb scripts check
```

### Exports

An export job writes its file to the system's temporary folder as the
rows are read, a page at a time, then copies it to the files' store,
where it is kept 24 hours. `EXPORT_MAX_ROWS` (100,000 to 10,000,000,
1,000,000 by default) is the most rows one export writes: a larger view
is refused before anything is written, and people are asked to filter
it. Leave room in the temporary folder for the largest file, once per
export running at once (`JOB_CONCURRENCY`).

### Base snapshots

A base's snapshot with its rows is an archive written to the temporary
folder as each table is read, a thousand rows at a time, then copied to
the files' store, where it is kept 24 hours. `EXPORT_MAX_ROWS` is the
most rows one snapshot writes and `IMPORT_MAX_ROWS` the most one import
reads, all tables together; a copy of a base takes the smaller of the
two. An uploaded snapshot is read through once, to check it, before it is
kept; its import reads it again a batch at a time as it writes. Leave room
in the temporary folder for the largest archive, its attachments
included (2 GiB at most), once per snapshot job running at once.

### Restore points

A base's manager keeps the whole base on the instance before a risky
change, and restores it as a new base if it goes wrong. Each point is a
snapshot archive in the files' store, under `restore-points/`, kept for
the days set on Administration's Security page (30 by default, 365 at
most), 20 per base at most; a shorter length ends the points already made
sooner, and the nightly purge deletes those that have ended. They count in the store's size and in its backups: a point lives
and ends with the instance, and a file to keep elsewhere is still the
base's export.

## When no administrator can sign in

A password forgotten where no email goes out, a second factor lost with
its backup codes, an identity provider out of reach, a list of sign-in
addresses that leaves your network out: Administration cannot help, since
nobody can open it. Run this where the instance runs (ADR 0082):

```sh
docker compose -f compose.yml -f compose.release.yml \
  --env-file .env --env-file image-pin.env exec app \
  anygriddb admin recover --email ada@example.org
```

The account of that address becomes an active administrator, and the
command prints a link that sets its password, once, within the hour, to
this terminal and nowhere else. Add what the case calls for:

| Flag                      | When                                                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--clear-factors`         | The second factor is lost too. The account's factors and sessions are removed, and it enrols a factor again. Without the flag they stay: the link alone does not open an account that has one.                                    |
| `--create "Ada Lovelace"` | The address has no account, or its account signs in through the identity provider and keeps no password: name another address, and an account is made for it under that name. Without the flag, an address nobody has is refused. |
| `--any-address`           | The list of sign-in addresses (Administration, Security) leaves you out. It is emptied: set it again once signed in.                                                                                                              |

Each change is on the sign-in trail as made from the command line, and
reaches your collector if the trail is shipped to one. Running the command
again changes nothing more and replaces the link.

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
version=X.Y.Z   # the release to install
git fetch --tags
git tag -n20 "v$version"         # its notes
git checkout "v$version"
scripts/build-image.sh
cd docker && docker compose up -d
```

Read the notes before a release that changes the first number of the
version, or the second before 1.0: it may ask for a step of its own.

Migrations run when AnyGridDB starts, under a lock, so two instances
starting at once do not both migrate.

A release that asks for a step before the upgrade looks for it before
its first migration runs. When the step was not done, AnyGridDB does not
start, and its log (`docker compose logs app`) says "Upgrade refused"
and what to do. Nothing was changed: start the version before again,
with the Compose files and the pin it was installed from, do the step,
then upgrade (ADR 0106).

Administration > Health then shows the version and the commit running.
An administrator may opt in there to check GitHub for a newer release;
the default makes no outbound call. When a newer release is found, a
dismissible notice appears in Administration until that version is
dismissed or the instance is upgraded.
`docker compose exec app anygriddb version` says the same, and so do the
image's labels: `docker compose images app`, then `docker image inspect`
on that image.

### Links of rows already in the trash

A row deleted by a version before this command existed comes back without
the links other rows held to it through a one-to-many field: the keys were
cleared, and only the change trail remembers them. To have a restore bring
them back, run this once after updating:

```bash
docker compose exec app anygriddb trash recover-links --dry-run
docker compose exec app anygriddb trash recover-links
```

It only adds to the change trail, changes no row, and running it again adds
nothing. A link set again since stays as it is, and a row locked or signed
since is left alone and counted when the restore is made.

## A stack made before the role was limited

A stack whose PostgreSQL volume was made by an earlier file has
`POSTGRES_USER` as the cluster's first role, which PostgreSQL keeps a
superuser. It works as before. To see which you have:

```sh
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "select rolsuper from pg_roles where rolname = current_user"
```

`f` is the limited role. `t` is the earlier one; to change it, the data
moves to a new volume: back up (`scripts/backup.sh`), stop the stack,
remove the volume `<project>_postgres_18` alone, start the stack, which
makes the volume and the role anew, and restore (`scripts/restore.sh`).

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
- `rustfs_data.tar.gz`, with `compose.s3.yml`: the object store that
  runs beside the stack, where the files then are;
- `SHA256SUMS`.

Files kept in an object store outside the stack (`STORAGE_DRIVER=s3`
toward a service of your own) are not in the backup, and the script says
so each time: keep that bucket with its service's own means, versioning
or replication.

A run that fails, or that is stopped, keeps nothing of what it had
written: a folder is a whole backup, with its sums, or is not there.

The folder and its files are readable by their owner only. Emails,
names, and cell values are in them, while secrets sealed with
`AUTH_ENCRYPTION_KEY` stay ciphertext because the backup leaves that key
out: keep the key in another place than the backups.

Encrypt each backup as it is written with [age](https://age-encryption.org)
(BSD licence, in most distributions' packages). Make a key pair on a
machine other than the host, keep its identity (the private key) there,
and give the host only the public key:

```sh
age-keygen -o anygriddb-backup.key   # prints "Public key: age1…"
```

```sh
# docker/.env on the host
BACKUP_AGE_RECIPIENT=age1…
# Optional: remove this stack's backups older than 30 days.
BACKUP_KEEP_DAYS=30
```

Each file then ends in `.age` and nothing readable touches the disk: the
host cannot read its own backups back. `BACKUP_KEEP_DAYS` removes only
folders this script named for this stack, once the new backup has
succeeded.

Run it from cron, for example nightly:

```cron
15 2 * * * cd /srv/anygriddb && scripts/backup.sh >> data/backups/backup.log 2>&1
```

Each run tells the instance how it ended. Administration > Health shows
the last ones, and administrators are told, there and by email, when the
last backup failed or when none has succeeded for 36 hours (they choose
the delay, or turn the alert off). Nothing is said about late backups
before a first one is reported. A backup made by other means, such as a
managed PostgreSQL's own, reports itself the same way when it ends:

```sh
docker compose exec app anygriddb backups record \
  --name nightly-2026-11-13 --started 2026-11-13T02:15:00Z   # add --failed when it failed
```

To restore one, into a stack with the same `AUTH_ENCRYPTION_KEY`:

```sh
scripts/restore.sh data/backups/anygriddb-20261108T021500Z
# An encrypted backup: the identity, brought for the restore.
BACKUP_AGE_IDENTITY=/path/to/anygriddb-backup.key \
  scripts/restore.sh data/backups/anygriddb-20261108T021500Z
```

The script replaces nothing until the backup has proved itself, while
AnyGridDB keeps serving:

1. `SHA256SUMS` must list every file of the backup, and each must match.
2. Every file is decrypted if it is encrypted, and every archive and the
   dump are read to their end.
3. There must be room for a second copy of the database and the files.
4. The dump is restored whole into a temporary database.
5. `anygriddb keys status` must open what the backup sealed, with the key
   in place or one of `AUTH_ENCRYPTION_PREVIOUS_KEYS`.

It then stops AnyGridDB, puts the restored database and files in place by
renaming, and starts AnyGridDB again with service certificates issued
from the restored authority, so a spare stack serves too. The previous
data is removed only once AnyGridDB is healthy. If anything fails before
that, what was there comes back and AnyGridDB starts again on it. A
restore stopped by force (a power cut, `kill -9`) is put back by the next
run of the script. `RESTORE_START_SECONDS` is how long AnyGridDB is given
to start healthy (600 by default): raise it when a restore must also run
long migrations.

The script exits 3 when the key in place does not open the backup, 4 when
there is no room for two copies, and 1 on any other refusal or failure.

Two options, right after the folder:

- `--in-place`, when the disk cannot hold two copies: the same checks of
  the files, then the data is replaced directly. **A failure then cannot
  be undone**: AnyGridDB stays stopped until a sound backup is restored.
- `--keep-store-files`, for a backup that holds none of the object
  store's files, on a stack that runs one: the rest is restored and the
  store keeps the files it has, which may no longer match the database.
  Without it, such a backup is refused.

Try a restore on a spare stack now and then: an untested backup is a
hope.

The scripts take `docker compose` options after their arguments
(`-p name -f compose.yml -f other.yml`) and read `ENV_FILE` instead of
`docker/.env` when it is set. Give both the options the stack runs with:
a backup made with `-f compose.yml -f compose.s3.yml` is restored with
them, into a stack that runs the object store.

An install from the published image holds no script: they are in the
repository, at the release's tag. Take a checkout of it beside the
install's folder, and name the files the stack runs with, by their full
paths:

```sh
git clone --depth 1 --branch "v$version" \
  https://github.com/anygriddb/anygriddb.git checkout
cd anygriddb   # the folder of compose.yml and .env
ENV_FILE="$PWD/.env" BACKUP_DIR="$PWD/backups" \
  ../checkout/scripts/backup.sh \
  -f "$PWD/compose.yml" -f "$PWD/compose.release.yml" \
  --env-file "$PWD/image-pin.env"
```

`scripts/restore.sh` takes the backup's folder, then the same options,
with the same `ENV_FILE`.

A base's owner can also save one base, from its settings: a
`.anygriddb.json` file, or a `.anygriddb.zip` archive with its
attachments (ADR 0039), imported again from "New base", on this
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

1. In **Administration → People → Provisioning (SCIM)**, create a token.
   Copy it at once: it is not shown again. It works while its maker is an
   active administrator.
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
3. Give each group a role in the settings of the bases it should reach,
   or on the group's page under **Administration → People → Groups**.

What to know:

- Accounts are keyed by email. A provisioned user whose email already
  has an account takes it over.
- A group can also be made in Administration, without a provider: its
  name and members are kept there (ADR 0070). The provider neither sees
  nor changes it, and a group it sends under the same name is refused
  until one of the two is renamed. A provider's group shows its members
  in Administration, where they cannot be changed.
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

## The administration API

What a script of yours asks of Administration, without a browser
(ADR 0086): list and make accounts, list the invitations that wait,
read the settings, and change the ones of the instance's running.

1. In **Administration → Connections → Administration API**, make a
   token: a name, how many days it lives, and what it may do
   (`accounts`, `invitations`, `settings`). Making one asks for your
   password or second factor. The token is shown once.
2. Call the API with it:

   ```bash
   # Maintenance on before an upgrade, with a word for those who open the app.
   curl -sS -X PATCH https://<your address>/api/v1/admin/settings \
     -H "Authorization: Bearer $ANYGRIDDB_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"maintenance": true, "banner": "Back at noon"}'
   ```

   `https://<your address>/api/v1/admin/openapi.json` describes every
   request in OpenAPI 3.1, and needs no token.

What to know:

- A token works while the administrator who made it is one. What it
  does is on the trails under their name, as done with a token. Any
  administrator revokes it from the same page, at once.
- A token cannot give the proof Administration asks for a change, so it
  does nothing that proof guards. An account it makes is never an
  administrator and has no role on a base. The settings it changes are
  those of the instance's running: `maintenance`, `banner`,
  `defaultLocale`, `attachmentMaxBytes`, `releaseCheck`, the alerts'
  thresholds, and the map's tiles. Security, who may sign up, and the
  instance's name and mail are changed in Administration.
- A new account gets a link that sets its first password: mailed to
  its address where mail is set up, handed back in the answer where it
  is not.
- A setting the instance's environment holds is refused, as on screen.
- The tokens people hold for their bases, provisioning tokens and
  sessions do not open this API.
- Requests count in the API's rate limit, 600 a minute per address.

## Several API processes

The supported production shape is **one API process** with the Compose
stack in this repository (or an equivalent single instance against a
managed PostgreSQL). Several API processes behind a load balancer work
for reads and writes, with these limits:

- **Rate limits** are counted in each process's memory. Put the
  balancer's addresses in `ANYGRIDDB_TRUSTED_PROXIES`, so clients are
  keyed by their real address, and enforce an overall limit on the
  proxy: otherwise N replicas multiply every bucket.
- **WebSocket presence** is per process. Fan-out uses PostgreSQL
  `LISTEN`/`NOTIFY`, so other browsers see row changes, but presence and
  some in-memory gates are not shared.

The balancer asks each process `/ready`: it answers 200 while PostgreSQL
answers within two seconds, and 503 otherwise, so requests go to a
process that can serve them. `/health` only says the process is up.
`/healthz` answers the same as `/health`. `/readyz` answers the same as
`/ready`, and also 503 when a migration this process knows is not applied.
See [Health](integrations/health.md).

Helm charts and multi-region active-active stay outside this repository.

## How much a read may hold

One request holds at most 64 MiB of rows, all its calls together, and one
process holds at most a quarter of its heap for all of them (ADR 0110).

- Past the first, the read answers `page_too_large` (400): ask for fewer rows
  or fields. The app's own pages of 100 rows are far below it.
- Past the second, it answers `reads_busy` (503): try again in a moment. If it
  comes often, give the container more memory or add a process.

Exports, snapshots and automations run in the background and are not counted.

## Recovery objectives (RPO / RTO)

With the nightly cron example under [Backups](#backups):

| Objective | Typical with the scripts                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO**   | Up to the time since the last successful `scripts/backup.sh` (about 24 hours on the sample cron). Continuous WAL archiving on your PostgreSQL shortens it.     |
| **RTO**   | The time to run `scripts/restore.sh` on a spare host with the same `AUTH_ENCRYPTION_KEY`, plus DNS or load-balancer cutover. Measure it once on a spare stack. |

Restore onto a spare stack after every major upgrade.

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

Administration shows the recent warnings, failures, and the process's own
messages under Instance, Logs (ADR 0087). A word typed there keeps the
lines of the chosen level that contain it: the message, the path, the
code, the address. Successful requests stay on the
container's output. The page keeps a line's time, level, message, the
request's method, path and address, and a failure's kind, code and frames.
The lines live in the process's memory and disappear when it stops. The
database and the file store log where they run. A collector pointed at the
container's output keeps the full copy, including lines from before the
last start.

## Sign-in events to a collector

Apart from its logs, the instance can send the events of its sign-in trail
that a watch cares about, as they happen: failed sign-ins, locks, accounts
made, changed, disabled or deleted, the roles of Administration, settings,
second factors removed, tokens. Each carries ids, codes and the client's
address, never an email or a secret. Two ways, alone or together:

- **Over HTTPS**, to a public address, set and tried in Administration,
  Connections: each event is posted as JSON, signed with a secret you give
  (ADR 0056).
- **As syslog over TLS** (RFC 5425), to a collector of your network
  (ADR 0084), set and tried in Administration, Connections: its host, its
  port (6514 unless you give another), and, when an authority of your
  own signed its certificate, that authority's certificate (PEM). It is
  saved once it took a test event. A collector on a private network
  needs private networks allowed, under Notifications; the machine
  itself and a cloud's metadata address are never a collector (ADR 0105).

  An operator may name the collector where the instance is installed
  instead. It then holds whatever Administration saved, and
  Administration shows it and cannot change it (ADR 0083). In `.env`:

  ```sh
  SYSLOG_HOST=logs.internal
  SYSLOG_PORT=6514
  ```

  with the authority's certificate mounted in the application's
  container through a Compose file of your own, and named:
  `SYSLOG_CA_FILE=/run/secrets/syslog_ca`. The instance does not start
  on a value that names no collector.

  Either way the collector's certificate is verified for its name. Each
  event is one RFC 5424 line (facility `local0`, application
  `anygriddb`, message id `auth`) whose message is the event as JSON. It
  leaves from the queue, and is tried again when the collector is away.
  Nothing is sent in clear text.

## Metrics and traces

Both are off until you turn them on (ADR 0018).

- **Metrics.** Set `METRICS_TOKEN` (32 characters or more), or save a
  token under Administration, Connections, Notifications. The
  environment wins when it is set. Without either, `/metrics` answers 404. Prometheus reads `/metrics` on AnyGridDB's HTTPS port with that
  token:

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
  and the process. Six more:
  `anygriddb_db_query_duration_seconds` (how long a query on
  AnyGridDB's own database took; the statement is not a label),
  `anygriddb_database_size_bytes`,
  `anygriddb_database_reachable` (0 while that database answers no
  scrape; `/metrics` keeps answering),
  `anygriddb_websocket_connections` (browser sockets on this process),
  `anygriddb_websocket_refused_total` (sockets closed or refused for
  what they cost, by reason: `slow_reader`, `too_many_messages`,
  `too_many_sockets`),
  and `anygriddb_automation_scripts_total` (scripts automations ran, by
  how each ended: `success`, `error`, `timeout`, `memory`, `stopped`).
  Rules to start from:

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

- **Traces.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` to your OTLP/HTTP
  collector, over HTTPS. Set `OTEL_EXPORTER_OTLP_HEADERS` for its
  credentials, and `OTEL_SERVICE_NAME` if `anygriddb` does not suit.
  When the environment does not name a collector, an administrator can
  save one under Notifications; saving it replaces the exporter that is
  running. Spans cover requests, the procedures under them, transactions
  in client databases, and background tasks. Errors can go to a
  Sentry-compatible store from that same page. See
  [Errors and traces](integrations/errors.md).

## Acceptance checklist

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
11. If you use a SIEM, save the webhook, or your syslog collector,
    send a test event, and confirm it arrives (with a valid signature,
    over HTTPS).
12. Scrape `/metrics` with `METRICS_TOKEN` over HTTPS.
