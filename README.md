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

- **Your databases**:
  - Declare PostgreSQL, MySQL, MariaDB, SQL Server, and Oracle sources.
  - Show their tables and views in a base; foreign keys become links.
  - Edit, add, and delete rows where an administrator allows it, compared under lock.
  - Add fields of your own in a schema the DBA grants.
  - Follow changes other applications make.
  - Read a table from a copy refreshed in AnyGridDB when live queries are not welcome.
- **Grid**: virtualized rows and columns, keyboard navigation, copy and paste with spreadsheets, fill down, undo and redo, footers, grouping, row colours, and frozen columns.
- **Fields**: 27 types, including links (one-way or two-way, limited to a view or a filter), lookups and rollups (over the linked rows that match a condition), formulas (94 functions, regular expressions and JSON included), users, attachments with thumbnails, ratings, durations, system fields, the row's id, and buttons.
- **Views**: grid, form (fields shown on earlier answers), kanban, gallery, calendar (a private iCal feed per person), timeline, and map; personal and locked views; nested and/or filters with relative dates and ranges.
- **Collaboration**: live updates and presence, comments with replies and @mentions, notifications (in-app, optionally by email), row history, trash and restore.
- **Trash**: deleted bases, tables, fields, and views wait 30 days, or as long as an administrator chooses, with their data, links, and view settings, and come back in one click.
- **Sharing**: owner, editor, commenter, and viewer roles per base or per table; invitations; public views and forms with optional password and expiry.
- **Data**: import CSV, TSV, JSON, or Excel with type detection, column mapping, and updates by key; import an Airtable base (tables, links, lookups, formulas, views, and rows, with a report of what differs); export a view as CSV, JSON, or Excel; back up a whole base, with its attachments and members, as one file to import again, or keep it on the instance as a restore point, restored beside the base in one step; duplicate tables and fields; base templates. Long imports, exports, and copies run as background jobs with live progress and can be cancelled.
- **Integrations**: REST API with an OpenAPI 3.1 document per base and a page to try requests, an MCP server for the AI you run ([docs/mcp.md](docs/mcp.md)), scoped API tokens, webhooks with filters, retries, and a delivery log, and automations (row, form, schedule, button, or incoming webhook triggers; branches and loops over rows). These work on your databases' tables too.
- **Dashboards**: metrics, charts (columns, bars, lines, areas, shares, with series), and embedded views. Each chart's values are computed by the database that holds the rows, under each reader's rights.
- **Security and compliance**:
  - Argon2id passwords, TOTP and passkeys, OIDC and SAML; SCIM 2.0 provisioning of accounts and groups, which get roles on bases.
  - An append-only audit trail with reasons and sources.
  - Row statuses and signatures confirmed by password (simple electronic signatures), fingerprinted on a client's rows.
  - Field and row rules enforced on every engine.
  - HTTPS only, and every connection encrypted and verified.
  - Rate limits and account erasure.
- **Administration**: accounts and their sessions, second factors, tokens, locks, and reset links, a security policy from simple defaults (who needs a second factor, locks and alerts, sessions, passwords, who creates bases and tokens, public links, sign-up and invitation domains, idle accounts), sign-up policy, maintenance and an announcement, the instance's own name, logo, and mail signature, sources, the audit and sign-in trails (CSV export), an access report, jobs and failed deliveries, service health and a support bundle, and Prometheus metrics and OpenTelemetry traces when the operator turns them on. An administrator reads a base they are not a member of only by opening it for an hour, with a reason its owners are told. Two roles stand beside administrators: support, which helps a person sign in again, and an auditor, who reads every page and changes nothing.
- English-source interface with a complete French locale, light and dark themes.

## Quick start

To run an instance people will use, install a release: the published
image, pinned by version and digest, as [`docs/operations.md`](docs/operations.md#install)
shows. The two ways below run this checkout instead.

Host development (AnyGridDB on the machine, PostgreSQL in Docker):

```bash
cp docker/.env.example docker/.env   # fill POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
cp .env.example .env                 # fill DATABASE_URL and AUTH_ENCRYPTION_KEY
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

The first account you create administers the instance. Creating a base requires a second factor (TOTP or a passkey).

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

| Doc                                                | What                                                 |
| -------------------------------------------------- | ---------------------------------------------------- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)               | How the pieces fit and their contracts               |
| [`TECH_STACK.md`](TECH_STACK.md)                   | What this tree uses                                  |
| [`ROADMAP.md`](ROADMAP.md)                         | What is done, known limits, what next                |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)               | Dev conventions, setup, tests, PR workflow           |
| [`OPEN_SOURCE_POLICY.md`](OPEN_SOURCE_POLICY.md)   | Legal-safe dependency rules                          |
| [`docs/adr/`](docs/adr/README.md)                  | Stack decisions, their costs, rejected options       |
| [`docs/migration-plan.md`](docs/migration-plan.md) | The phases that brought the tree here (historical)   |
| [`docs/sources.md`](docs/sources.md)               | Connecting a client database: accounts and TLS       |
| [`docs/operations.md`](docs/operations.md)         | Install, offline, upgrade, backup, managed DB        |
| [`docs/mcp.md`](docs/mcp.md)                       | Connecting the AI you run through the MCP server     |
| [`SECURITY.md`](SECURITY.md)                       | What is protected, and how to report a weakness      |
| [`ACCESSIBILITY.md`](ACCESSIBILITY.md)             | Accessibility commitment and how to report a barrier |
| [Code of conduct](.github/CODE_OF_CONDUCT.md)      | Expected behaviour in the project's spaces           |

## License

[AGPL-3.0-or-later](LICENSE)

Org: https://github.com/anygriddb · Repo: https://github.com/anygriddb/anygriddb
