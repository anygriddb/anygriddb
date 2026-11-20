# AnyGridDB

A spreadsheet interface on the databases you already run: open source, **AGPL-3.0**, OSI-approved, with no paid feature locks.

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![OSI](https://img.shields.io/badge/OSI-approved-green.svg)](https://opensource.org/licenses/AGPL-3.0)
[![Commits](https://img.shields.io/badge/commits-conventional-green.svg)](https://www.conventionalcommits.org/en/v1.0.0/)

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
- **Sharing**: owner, editor, commenter, and viewer roles per base or per table, with field and row rules; public views, forms, and read-only bases, with a password and an expiry.
- **Data**: import and export of CSV, TSV, JSON, and Excel; an Airtable base or a workbook made a base; base backups, restore points, and templates.
- **Integrations**: a REST API with an OpenAPI 3.1 document per base, an [MCP server](docs/mcp.md) for the AI you run, scoped tokens, OAuth for applications, webhooks, and automations that run scripts of your own.
- **Dashboards**: metrics, charts, and a view's rows, computed by the database under each reader's rights.
- **Security**: Argon2id passwords, TOTP and passkeys, OIDC, SAML, and SCIM; an append-only audit trail; row statuses and signatures; HTTPS only, every connection encrypted and verified.
- **Administration**: accounts, the security policy, sources, the trails, and health in one place; support and auditor roles; an [administration API](docs/operations.md#the-administration-api) for an operator's scripts. An administrator who opens a base they are not a member of, or acts with a person's rights, gives a reason, and the people concerned are told.
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

Open https://localhost:3000: the app and its API share that address. Set `PUBLIC_URL` to the HTTPS origin people type (a hostname such as `https://grid.example.org` or `https://grid.lan:3000`). Put extra certificate names or IP addresses in `TLS_NAMES`. `http://` on the same port redirects there.

AnyGridDB serves HTTPS only, secure by design (ADR 0029):

- With your own certificate, set `TLS_CERT_FILE` and `TLS_KEY_FILE` (see `docker/.env.example`).
- Without one, AnyGridDB makes its own authority at the first start and signs its certificate with it. Browsers warn until you install that authority, once per workstation: download it from Administration > Health, or from `https://<address>/tls/authority.crt`, and check its SHA-256 fingerprint against the one shown there and in the start log. It can only vouch for AnyGridDB's addresses, never for another site.
- Passkeys need that trust **and** a DNS hostname (or `localhost`) in `PUBLIC_URL`, matching the address in the browser. An IP-only `PUBLIC_URL` keeps HTTPS and TOTP; passkeys stay off until you give the instance a resolvable name (see `docs/operations.md`).

Inside the stack too, every connection is encrypted and verified (ADR 0030): PostgreSQL takes TLS connections only and RustFS serves HTTPS, with certificates a one-shot `certs` service issues before they start. A `DATABASE_URL`, `S3_ENDPOINT`, or SMTP relay beyond the machine must use verified TLS, or AnyGridDB does not start.

Files live on the `files` volume. To keep them in an S3-compatible store, start with `docker compose -f compose.yml -f compose.s3.yml up -d --build` (RustFS), or point `STORAGE_DRIVER=s3` and `S3_*` at your own service.

The first account you create administers the instance, and takes a token only its operator can ask for: `docker compose exec app anygriddb install-token`. Creating a base requires a second factor: an authenticator app (TOTP), a passkey, or, for anyone but an administrator and where mail is set up, a code by email.

## Layout

Two apps (`apps/web`, `apps/api`), three packages (`packages/core`,
`packages/db`, `packages/ui`), and the install path (`docker/`): what each
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
| [`docs/brand.md`](docs/brand.md)                 | Notebook identity: type, colour, BrandMark           |
| [`docs/i18n-glossary.md`](docs/i18n-glossary.md) | The words the interface uses                         |
| [`docs/weblate.md`](docs/weblate.md)             | Weblate and a third locale                           |
| [`OPEN_SOURCE_POLICY.md`](OPEN_SOURCE_POLICY.md) | Legal-safe dependency rules                          |
| [`NOTICE.md`](NOTICE.md)                         | Copyright notice and selected dependency licenses    |
| [`ACCESSIBILITY.md`](ACCESSIBILITY.md)           | Accessibility commitment and how to report a barrier |
| [Code of conduct](.github/CODE_OF_CONDUCT.md)    | Expected behaviour in the project's spaces           |

### Architecture

| Doc                                  | What                                           |
| ------------------------------------ | ---------------------------------------------- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the pieces fit and their contracts         |
| [`docs/adr/`](docs/adr/README.md)    | Stack decisions, their costs, rejected options |

The phases that brought the tree here are history:
[`docs/history/migration-plan.md`](docs/history/migration-plan.md).

## License

[AGPL-3.0-or-later](LICENSE)

Org: https://github.com/anygriddb · Repo: https://github.com/anygriddb/anygriddb
