# Sample database lab

Opt-in Docker engines and seeded sample databases for exercising AnyGridDB
external sources (ADR 0006) against real schemas: Chinook, Northwind,
Sakila/Pagila, and AdventureWorks (SQL Server).

This is **not** the official product stack. SQL Server uses Compose profile
`mssql` and Oracle Free profile `oracle` — interoperability images only
(`OPEN_SOURCE_POLICY.md`).

## Quick start

```bash
cd docker/lab
cp .env.example .env
docker compose up -d
docker compose --profile mssql --profile oracle up -d   # optional engines
../../scripts/lab/seed.sh
../../scripts/lab/seed.sh --adventureworks   # SQL Server only, ~210 MB download
```

`seed.sh` first runs `scripts/lab/fetch-seeds.sh`, which downloads each
dataset from its pinned upstream version into `seeds/` (not committed)
and checks its SHA-256; a file that changed upstream stops the script.

Or from the repo root:

```bash
./scripts/lab/up.sh
./scripts/lab/seed.sh --all
```

## Ports

| Engine          | Container            | Host                     |
| --------------- | -------------------- | ------------------------ |
| PostgreSQL 17   | `aglab-pg`           | `127.0.0.1:55432`        |
| MySQL 8.4       | `aglab-mysql`        | `127.0.0.1:53306`        |
| MariaDB 11.4    | `aglab-mariadb`      | `127.0.0.1:53307`        |
| SQL Server 2022 | `aglab-mssql`        | `127.0.0.1:51433`        |
| Oracle Free 23  | `aglab-oracle` (TCP) | `127.0.0.1:51521`        |
|                 | `aglab-oracle-tls`   | `127.0.0.1:52484` (TCPS) |

Password: `LAB_PASSWORD` from `.env` (default in `.env.example`).

Least-privilege login created by seed: user `anygriddb` / same password,
plus side schema `anygriddb_side` (Postgres/SQL Server), database `ag_side`
(MySQL/MariaDB), or the reader's own schema `ANYGRIDDB` (Oracle).

## Databases after seed

| Engine          | Databases / schemas                                                    |
| --------------- | ---------------------------------------------------------------------- |
| PostgreSQL      | `chinook`, `northwind`, `pagila`                                       |
| MySQL / MariaDB | `Chinook`, `northwind`, `sakila`                                       |
| SQL Server      | `Chinook`, `northwind`, `AdventureWorks2022` (with `--adventureworks`) |
| Oracle          | service `FREEPDB1`, schema `CHINOOK`                                   |

## TLS

`./scripts/lab/up.sh` generates `certs/ca.crt` + server material. Engines
require TLS (`require_secure_transport` / `forceencryption` / Postgres `ssl` /
Oracle TCPS via `aglab-oracle-tls`). Paste `certs/ca.crt` into each source’s
CA field (or set `ANYGRIDDB_LAB_TLS_CA` for the samples suite).

## Point AnyGridDB at the lab

```bash
export ANYGRIDDB_SOURCES_ALLOWED_HOSTS=127.0.0.1,localhost
# Paste docker/lab/certs/ca.crt into each source (no plaintext).
./scripts/lab/register-sources.mjs
```

## Automated tests

```bash
# Against the lab (preferred locally):
ANYGRIDDB_LAB_HOST=127.0.0.1 \
ANYGRIDDB_LAB_TLS_CA="$PWD/docker/lab/certs/ca.crt" \
  pnpm test:samples

# Or start throwaway containers with Testcontainers (as the weekly CI
# workflow .github/workflows/samples.yml does):
pnpm test:samples
```

Without `ANYGRIDDB_LAB_HOST`, the suites' global setup
(`apps/api/src/sources/samples/world-global.ts`) starts the five engines
once, on the loopback without TLS, and loads them with `seed.sh`, which
takes the containers from `LAB_PG_CONTAINER`, `LAB_MYSQL_CONTAINER`,
`LAB_MARIADB_CONTAINER`, `LAB_MSSQL_CONTAINER`, and `LAB_ORACLE_CONTAINER`
(the `aglab-*` names by default). Both paths get the same datasets and
grants. Start the lab with `./scripts/lab/up.sh --all` before a lab-hosted
`pnpm test:samples` so SQL Server and Oracle are up.

See `apps/api/src/sources/samples/` and `docs/sources.md`.

## Seed sources

Pinned versions, attribution, and licenses: [`seeds/SOURCES.md`](seeds/SOURCES.md).
Nothing of them is committed or shipped with AnyGridDB.
