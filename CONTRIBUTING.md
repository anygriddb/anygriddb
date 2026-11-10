# Contributing to AnyGridDB

All contributions are **AGPL-3.0-or-later**. Stack and package roles:
[`ARCHITECTURE.md`](ARCHITECTURE.md), [`TECH_STACK.md`](TECH_STACK.md).
What works today: [`ROADMAP.md`](ROADMAP.md). Why it is built this way:
[`docs/adr/`](docs/adr/README.md).

## Hard rule — OSI only

Use OSI-approved open source only. Do **not** add SSPL, BSL, SUL, Fair Source,
Commons Clause, Elastic License, proprietary EULAs, or unclear licenses, and do
not require proprietary desktop runtimes for `docker/`. OSI **clients** may talk
to proprietary systems the operator already runs (SQL Server); we never
redistribute those servers. Full policy:
[`OPEN_SOURCE_POLICY.md`](OPEN_SOURCE_POLICY.md).

## Where to change what

| Path            | Owns                                                                 | Typical work                    |
| --------------- | -------------------------------------------------------------------- | ------------------------------- |
| `apps/web`      | Vite SPA: grid, views, record panel, forms, settings, admin          | UI, routes, grid behaviour      |
| `apps/api`      | Fastify: tRPC, REST `/api/v1`, MCP `/mcp`, WebSocket, files, workers | HTTP, auth, jobs, sources       |
| `packages/core` | Field types, bound SQL, formulas, filters, RBAC, Zod, error codes    | Read/write SQL, schemas, errors |
| `packages/db`   | Kysely client, SQL migrations, generated types                       | New migration, regenerate types |
| `packages/ui`   | Tailwind tokens, React Aria components                               | Shared controls and overlays    |
| `docker/`       | Official install path                                                | Compose, image, operations      |

**Open first**

- tRPC root: `apps/api/src/trpc/router.ts`; access checks: `apps/api/src/trpc/guard.ts`
- Session actor: `apps/api/src/trpc/init.ts` (`requireUser`)
- Row writes, for every transport: `apps/api/src/services/rows.ts`
- Row reads: `packages/core/src/query/read.ts` (`buildReadRows`)
- Zod inputs: `packages/core/src/schemas.ts`; error codes: `packages/core/src/errors.ts`
- Migrations and types: `packages/db/migrations/`, `packages/db/src/types.generated.ts`
- Grid: `apps/web/components/grid/grid-view.tsx`; cell editors: `apps/web/components/fields/cell-editor.tsx`
- Client databases: `apps/api/src/sources/`, guide [`docs/sources.md`](docs/sources.md)

**Where a bug usually lives**

| Symptom                                     | Look in                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Wrong value, filter, sort, formula, rollup  | `packages/core/src/query/` (one compiler, a dialect per engine)                       |
| Refused or wrongly allowed action           | `apps/api/src/trpc/guard.ts`, `packages/core/src/rbac.ts`, `apps/api/src/data/acl.ts` |
| A write lost, doubled, or not audited       | `apps/api/src/services/rows.ts`, then the migration's audit trigger                   |
| Something wrong only on a client's database | `apps/api/src/sources/`, `packages/core/src/query/dialect*.ts`                        |
| Screen, keyboard, or screen-reader issue    | `apps/web/components/`, shared controls in `packages/ui/src/`                         |
| Text missing or untranslated                | `apps/web/locales/`, `apps/web/lib/errors.ts`, `apps/api/src/mail-i18n.ts`            |
| Background job, import, export, automation  | `apps/api/src/job-runners.ts`, `apps/api/src/automations.ts`                          |

## Install and run

Needs **Node ≥ 26**, **pnpm 11** ([`mise.toml`](mise.toml): `mise install`),
and Docker for PostgreSQL and the heavier tests.

```bash
cp docker/.env.example docker/.env   # fill POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
cp .env.example .env                 # DATABASE_URL to that database on 127.0.0.1:5432,
                                     # AUTH_ENCRYPTION_KEY from `openssl rand -base64 32`
cd docker && docker compose -f compose.yml -f compose.dev.yml up -d db && cd ..
pnpm install && pnpm dev             # http://localhost:3000
```

The first account you create administers the instance. Full stack in Docker:
`cd docker && docker compose up -d --build` (see [`README.md`](README.md)).

| Command                                     | What                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm check`                                | format, conventions, lint, typecheck, unit tests — run before every PR            |
| `pnpm format`                               | format the tree with Prettier                                                     |
| `pnpm test`                                 | unit tests only (no Docker)                                                       |
| `pnpm test:integration`                     | PostgreSQL and client engines in Testcontainers                                   |
| `pnpm test:e2e`                             | Playwright journeys in Chromium, with axe accessibility checks                    |
| `pnpm test:samples`                         | sample databases on four engines ([`docker/lab/README.md`](docker/lab/README.md)) |
| `pnpm --filter @anygriddb/web i18n:extract` | refresh the Lingui catalogs                                                       |
| `pnpm --filter @anygriddb/db db:types`      | regenerate the Kysely types from `DATABASE_URL`, freshly migrated                 |

## Naming

Under `apps/`, `packages/`, `scripts/`, `docker/`, and `docs/`:

| Kind                      | Convention                      | Example                                                 |
| ------------------------- | ------------------------------- | ------------------------------------------------------- |
| Directories, source files | kebab-case                      | `grid-view.tsx`, `content-security-policy.ts`           |
| Names a tool imposes      | as the tool spells them         | `vite.config.ts`, `Dockerfile`, `README.md`             |
| Directory collections     | plural                          | `components/`, `migrations/`                            |
| React components          | PascalCase                      | `export function GridView` in `grid-view.tsx`           |
| Types, classes            | PascalCase nouns, no `I` prefix | `User`, not `IUser`                                     |
| Functions                 | camelCase, a verb first         | `readPage`, `isLoopback`, `roleAllows`                  |
| Variables, properties     | camelCase                       | `rowHeight`                                             |
| Module constants          | `UPPER_SNAKE_CASE`              | `MAX_READ_LIMIT`                                        |
| Unit, integration tests   | next to the module              | `read.ts` → `read.test.ts`, `audit.integration.test.ts` |
| Shared test helpers       | `*.test-helpers.ts`             | `caller.test-helpers.ts`                                |
| Browser journeys          | `apps/web/e2e/*.spec.ts`        | `editors.spec.ts`                                       |

Property names follow the data they describe (SQL rows, HTTP headers, SCIM),
so they are not checked.

## API, database, migrations

- **Contract**: Zod schemas in `packages/core`. tRPC is the app's API; REST
  `/api/v1` (OpenAPI per base) and MCP `/mcp` are the public ones.
- **New tRPC procedure**: in the router of its domain (`*-router.ts`), named
  with a verb — `list`, `get`, `create`, `update`, `delete`, or a domain verb
  (`duplicate`, `restore`, `revoke`). Existing names stay as they are.
- **New REST route**: plural resources under `/api/v1`
  (`/tables/:tableId/records`), described in the OpenAPI document.
- **Access**: guard first — `guardBase` / `guardTable` with `read`, `comment`,
  `write`, or `manage`. The actor comes from the session, never from an id the
  client sends.
- **Row writes**: always `apps/api/src/services/rows.ts` (tRPC, REST, MCP,
  automations, forms). There is no second write path.
- **Product SQL**: bound parameters, built in `packages/core` only.
  `packages/db` does not grow query builders.
- **Errors**: `AppError` with a snake_case code registered in
  `packages/core/src/errors.ts`; the UI translates the code in
  `apps/web/lib/errors.ts`, never the English message.
- **Catalog tables**: plural snake_case (`data_tables`, `role_bindings`);
  columns snake_case; `*_at` timestamps, `*_id` references. TypeScript sees
  camelCase (Kysely `CamelCasePlugin`).
- **User tables**: physical names from the catalog; system columns `id`,
  `ag_status`, `ag_seq`, `ag_created_at`, `ag_updated_at`, `ag_created_by`,
  `ag_updated_by`. They never go through the camelCase mapping.
- **Migrations**: a new `packages/db/migrations/NNNN_snake_case.sql` with the
  next free number. Never edit one that has been applied. Then regenerate the
  types; the integration test `db-types.integration.test.ts` fails when they
  lag.
- **Reads**: 1 to 1,000 rows per request (`MAX_READ_LIMIT`).

## Style and checks

- **Prettier** (`.prettierrc.json`, `.editorconfig`): double quotes,
  semicolons, two spaces. `pnpm format` fixes the tree.
- **ESLint** (`eslint.config.js`): TypeScript strict type-checked, the naming
  rules above, and the React Compiler's rules in `apps/web` and `packages/ui`.
- **TypeScript**: `strict`, `noUncheckedIndexedAccess`; no `any` or `as any`.
- **Dependencies**: exact versions (`pnpm add` pins them); a release younger
  than seven days is not installed. OSI licenses only.

What runs where:

| When             | What                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `git commit`     | Prettier on staged files; commit message format and `Signed-off-by`                                             |
| `pnpm check`, CI | format, `scripts/check-conventions.mjs` (file names, migrations, versions), ESLint, types, unit tests           |
| CI on every PR   | integration and e2e tests, translation catalogs, commit messages and sign-off, CodeQL, Trivy, dependency review |

## Messages (i18n)

The interface is written in **English** (Lingui, ADR 0041); French must stay
complete.

- In components: `` t`Create` `` / `<Trans>` (`useLingui` from
  `@lingui/react/macro`); named placeholders; `plural` for counts. Glossary:
  [`docs/i18n-glossary.md`](docs/i18n-glossary.md).
- After changing text: `pnpm --filter @anygriddb/web i18n:extract`, then fill
  `apps/web/locales/fr/messages.po`. CI fails when catalogs lag or French is
  missing.
- Names the server writes as data (a new table's grid, a copy) come from
  `packages/core/src/made-names.ts`, never a literal.

## From issue to pull request

1. **Pick the work**: a GitHub issue, a [`ROADMAP.md`](ROADMAP.md) item, or a
   known limit. Report bugs and ideas with the issue templates; report a
   vulnerability privately ([`SECURITY.md`](SECURITY.md)), never in an issue.
2. **Reproduce first**: write the failing test (or journey) before the fix.
3. **Branch** from `main` in your fork: `fix/short-name` or `feat/short-name`.
4. **Keep it small**, inside the package that owns the job.
5. **Test**: a colocated test with one accepted and one refused case, unless
   docs only. SQL, audit, or sources → `pnpm test:integration`. A user journey →
   extend a spec in `apps/web/e2e` (one journey per flow, not per view).
6. **Text**: extract and translate (above).
7. **Check**: `pnpm check`.
8. **Commit**: Conventional Commits with `git commit -s` (DCO). Read your diff:
   no secrets, `.env` files, credentials, or personal data.
9. **Open the PR** against `main` with the template. Reviews are requested from
   [`.github/CODEOWNERS`](.github/CODEOWNERS).

### Conventional Commits

```
<type>[optional scope][optional !]: <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`. Header ≤ 100 characters, imperative, no final period.
Scope: the package or area touched (`web`, `api`, `core`, `db`, `ui`,
`docker`, `deps`, `e2e`, `i18n`), or none.

```
feat(api): add SQL Server connector
fix(web): restore filter hierarchy on import
feat!: drop SQLite as a production meta store

BREAKING CHANGE: production meta store is Postgres only.

Signed-off-by: Your Name <you@example.com>
```

Husky's `commit-msg` runs commitlint, then
`scripts/validate-conventional-commit.sh`; CI's `DCO / check` checks every
commit of a PR again. Renovate (npm) and Dependabot (GitHub Actions, Docker)
open dependency PRs; their commits are exempt from sign-off.

### On GitHub

The repository's ruleset, set on GitHub rather than in this tree, protects
`main`: pull request, one approval, signed commits, no force-push, and these
checks: `CI / unit`, `CI / integration`, `CI / e2e`, `Security / codeql`,
`Security / trivy`, `Security / dependency-review`, `DCO / check`. Secrets
belong in GitHub Actions secrets or `docker/.env`, never in the tree.

## Releases

The product's version is the root `package.json`'s, in SemVer; the
workspace packages stay `0.0.0` ([ADR 0048](docs/adr/0048-versions-and-releases.md)).
Until 1.0, a release that breaks something raises the second number
(`0.2.0` → `0.3.0`), anything else the third.

1. On an up-to-date `main`, with `CI` green: `pnpm check`,
   `pnpm test:integration`, and `pnpm test:e2e`.
2. Open a pull request whose one commit, `chore(release): vX.Y.Z`, sets
   `version` in the root `package.json`.
3. Once it is merged, tag the commit it became on `main`:
   `git tag -a vX.Y.Z <commit>`. The tag's message is the release notes
   for operators: what was added, changed, and fixed, and first what
   breaks and what to do about it (environment variables, storage,
   PostgreSQL version).
4. Push the tag: `git push origin vX.Y.Z`.
