# AnyGridDB

A spreadsheet interface on the databases you already run: open source, **AGPL-3.0**, OSI-approved, with no paid feature locks.

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![OSI](https://img.shields.io/badge/OSI-approved-green.svg)](https://opensource.org/licenses/AGPL-3.0)
[![Release](https://img.shields.io/github/v/release/anygriddb/anygriddb?sort=semver)](https://github.com/anygriddb/anygriddb/releases/latest)
[![CI](https://github.com/anygriddb/anygriddb/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/anygriddb/anygriddb/actions/workflows/ci.yml?query=branch%3Amain)
[![Quality gate](https://sonarcloud.io/api/project_badges/measure?project=anygriddb_anygriddb&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=anygriddb_anygriddb)

Every table is a real SQL table, in AnyGridDB's own PostgreSQL or in your own database: PostgreSQL, MySQL, MariaDB, SQL Server, or Oracle.

- **Data stays where it lives.** AnyGridDB reads a client's tables through a dedicated account over verified TLS, and never changes their schema.
- **One query per page, in the engine that holds the rows.** Formulas, lookups, rollups, filters, sorts, groups, and charts are computed there. They mean the same on every engine, which a conformance suite checks; where an engine computes differently, the field says so.
- **Writes are compared and recorded.** A change to a client's row is checked against what the person saw. Every write made through AnyGridDB is recorded in its audit trail.
- **Locked and signed rows are protected.** AnyGridDB refuses changes to them. A change another application makes is detected, and the right people are told.

## Features

In short; [`ROADMAP.md`](ROADMAP.md#done) says what works, area by area.

- **Your databases**: PostgreSQL, MySQL, MariaDB, SQL Server, and Oracle tables, read and edited where they live; a refreshed copy when live queries are not welcome, which is also how a MongoDB-protocol database and an OpenSearch cluster are read.
- **Grid**: virtualized rows and columns, keyboard navigation, copy and paste with spreadsheets, fill down, undo and redo, grouping, footers, and frozen columns.
- **Fields**: 30 types, with links, lookups, rollups, and formulas (94 functions) computed by the database that holds the rows.
- **Views**: grid, form, kanban, gallery, list, calendar, timeline, and map; personal and locked views; nested filters.
- **Collaboration**: live updates and presence, comments and @mentions, notifications, row history, and a trash that keeps what was deleted for 30 days.
- **Sharing**: owner, editor, commenter, and viewer roles per base or per table, and roles an administrator makes of their permissions (export, import, publish, delete apart), with field and row rules; public views, forms, and read-only bases, with a password and an expiry.
- **Data**: import of CSV, TSV, JSON, and Excel, and export to CSV, JSON, and Excel; an Airtable base or a workbook made a base; base backups, restore points, and templates.
- **Integrations**: a REST API with an OpenAPI 3.1 document per base, an [MCP server](docs/mcp.md) for the AI you run, scoped tokens, OAuth for applications, webhooks, and automations that run scripts of your own.
- **Dashboards**: metrics, charts, and a view's rows, computed by the database under each reader's rights.
- **Security**: Argon2id passwords, TOTP and passkeys, OIDC, SAML, and SCIM; an append-only audit trail; row statuses and signatures; HTTPS only, every connection encrypted and verified.
- **Administration**: accounts, the security policy, sources, the trails, and health in one place; support, auditor, account manager and source manager roles; an [administration API](docs/operations.md#the-administration-api) for an operator's scripts. An administrator who opens a base they are not a member of, or acts with a person's rights, gives a reason, and the people concerned are told.
- **Interface**: English source with a complete French locale, light and dark themes, on a phone and from the keyboard.

## Quick start

To run an instance people will use, install a release: the published
image, pinned by version and digest, as [`docs/operations.md`](docs/operations.md#install)
shows. The two ways below run this checkout for development; `main` is
not a release.

Host development (AnyGridDB on the machine, PostgreSQL in Docker):

```bash
cp docker/.env.example docker/.env   # fill POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, AUTH_ENCRYPTION_KEY
cp .env.example .env                 # fill DATABASE_URL and the same AUTH_ENCRYPTION_KEY
cd docker && docker compose -f compose.yml -f compose.dev.yml up -d db
cd .. && pnpm install && pnpm dev
```

Open http://localhost:3000, the development server on this machine; it forwards to the API, which serves HTTPS.

The full stack, in one image:

```bash
cd docker
cp .env.example .env          # every required value, no defaults for secrets
docker compose up -d --build
```

Open https://localhost:3000. Set `PUBLIC_URL` to the HTTPS origin people type.
HTTPS only (ADR 0029): your cert via `TLS_CERT_FILE` / `TLS_KEY_FILE`, or the
instance's own authority (fingerprint in the start log and Administration >
Health). Passkeys need a DNS hostname (or `localhost`) in `PUBLIC_URL`. TLS,
S3 files, and every other install detail: [`docs/operations.md`](docs/operations.md).

The first account administers the instance:
`docker compose exec app anygriddb install-token`. Creating a base requires a
second factor (TOTP, passkey, or email code where mail is set up).

## Layout

Two apps (`apps/web`, `apps/api`), three packages of code (`packages/core`,
`packages/db`, `packages/ui`) beside the compiler settings they share
(`packages/tsconfig`), and the install path (`docker/`): what each
owns is the table of [`CONTRIBUTING.md`](CONTRIBUTING.md#where-to-change-what).

## Principles

1. **AGPL-3.0-or-later**
2. **No paid feature locks**
3. **Self-host first**
4. **OSI stack only** — see [`OPEN_SOURCE_POLICY.md`](OPEN_SOURCE_POLICY.md)

## Docs

### Operator

| Doc                                        | What                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| [`docs/operations.md`](docs/operations.md) | Install, offline, upgrade, backup, managed DB                        |
| [`docs/integrations/`](docs/integrations/) | Notifications, heartbeats, metrics, errors and traces, health, OAuth |
| [`docs/sources.md`](docs/sources.md)       | Connecting a client database: accounts and TLS                       |
| [`docs/mcp.md`](docs/mcp.md)               | Connecting the AI you run through the MCP server                     |
| [`SECURITY.md`](SECURITY.md)               | How to report a vulnerability, and what protects an instance         |
| [`CHANGELOG.md`](CHANGELOG.md)             | What changes for those who run or use an instance                    |

### Contributor

| Doc                                              | What                                                 |
| ------------------------------------------------ | ---------------------------------------------------- |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)             | Dev conventions, setup, tests, PR workflow           |
| [`TECH_STACK.md`](TECH_STACK.md)                 | What this tree uses                                  |
| [`ROADMAP.md`](ROADMAP.md)                       | What is done, known limits, what next                |
| [`OPEN_SOURCE_POLICY.md`](OPEN_SOURCE_POLICY.md) | Legal-safe dependency rules                          |
| [`NOTICE.md`](NOTICE.md)                         | Copyright notice and selected dependency licenses    |
| [`ACCESSIBILITY.md`](ACCESSIBILITY.md)           | Accessibility commitment and how to report a barrier |
| [Code of conduct](.github/CODE_OF_CONDUCT.md)    | Expected behaviour in the project's spaces           |

### Architecture

| Doc                                  | What                                           |
| ------------------------------------ | ---------------------------------------------- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the pieces fit and their contracts         |
| [`docs/adr/`](docs/adr/README.md)    | Stack decisions, their costs, rejected options |

## License

[AGPL-3.0-or-later](LICENSE)

Org: https://github.com/anygriddb · Repo: https://github.com/anygriddb/anygriddb
