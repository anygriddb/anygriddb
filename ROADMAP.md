# AnyGridDB roadmap

The product is `apps/` and `packages/`.

## Done

| Area           | What works                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read engine    | One SQL query per page; formulas, lookups, rollups, and link labels compiled to SQL; offset paging with a total; `rows.get` by ids                                        |
| Filters        | And/or tree, three levels, 24 operators by value kind, ranges, relative dates in the caller's time zone, `me`                                                             |
| Grouping       | Up to three levels with counts; 20 footer aggregates                                                                                                                      |
| Formulas       | `{Field}` references, `& % >= <= <>`, 94 functions (math, text, regex, JSON, hashes, logic, errors, dates, working days, lists)                                           |
| Field types    | 26, including email, url, phone, multi-select, rating, datetime, duration, user, system fields, autonumber, and button                                                    |
| Schema editing | Add, rename, describe, reorder, convert (audited rewrite with a preview of lost values), duplicate, and delete fields; unique, defaults                                   |
| Links          | One-way or two-way, 1-n or n-n, limited to a view or a filter; lookups and rollups (17 functions) on matching linked rows                                                 |
| Grid           | Virtualized, keyboard navigation, rectangular selection with exact sums, copy and paste, fill down, undo and redo, frozen columns, row colours and height, comment counts |
| Views          | Grid, form, kanban (folding columns), gallery, calendar (private iCal feeds), timeline, map; descriptions; personal and locked views; duplicate and reorder               |
| Records        | Record panel: link, copy, delete, print; linked rows opened or created from the picker; field history, comments, @mentions, trash                                         |
| Attachments    | Multipart upload, type sniffing, WebP thumbnails, image preview, checked downloads                                                                                        |
| Roles          | Owner, editor, commenter, viewer; table overrides; invitations; roles given to identity-provider groups                                                                   |
| Public sharing | Read-only views and insert-only forms, fields shown on earlier answers or filled by the link, password, expiry, audited as `form:<share>`                                 |
| REST API       | `/api/v1`, OpenAPI 3.1 per base, requests tried from the API page, scoped tokens, typecast, field keys by name or label                                                   |
| MCP            | Streamable HTTP `/mcp` for the AI you run: the record tools of the REST API, bearer tokens only, read-only tokens offered reading tools; no embedded model                |
| Import, export | CSV, TSV, JSON, XLSX, or pasted rows: type detection, mapping, new fields, upsert by key, error report; CSV, JSON, XLSX export of a view                                  |
| Jobs           | Imports, exports, table copies, and base snapshots in a background queue: live progress, cancel, 24-hour files, interrupted-job recovery                                  |
| Trash          | Bases, tables, fields, and views restorable for 30 days with their data, links, and view settings; undo toast; purge job                                                  |
| Base snapshots | Export/import a base as `.anygriddb.json`, or a `.zip` with its files; people by email; copy it in one step; Airtable bases (Web API)                                     |
| Dashboards     | Metric, chart, and view widgets; charts on ECharts with series, sums, means, or shares computed by the source; a table view of each chart                                 |
| Field ACL      | Per-member hide/read/write fields and a row rule per table, enforced by the read engine on every surface and engine; audited; “view as”                                   |
| Templates      | CRM, project management, inventory, issue tracking                                                                                                                        |
| Webhooks       | Filters, watched fields, row values with the creator's rights, custom headers, delivery log, retries, auto-off, test call                                                 |
| Automations    | Row created, updated, deleted, in a filter, form, schedule, button, webhook; write or delete rows, email, HTTPS, notify; branches, loops                                  |
| Notifications  | Mentions, replies, assignments, automation and webhook alerts; live bell; optional email                                                                                  |
| Audit          | Append-only trail with reason and source, row statuses, password-confirmed signatures                                                                                     |
| Security       | Argon2id, TOTP, passkeys, OIDC, SAML, sliding sessions, rate limits, per-account locks, password change and reset, SSRF-safe requests, account erasure                    |
| Policy         | Administrator-set, from simple defaults (ADRs 0043, 0044): second factor, locks and alerts, sessions, passwords, tokens, links, domains, invitations, idle accounts       |
| Administration | Accounts (disable, admin, sessions, factors, tokens), SCIM 2.0, sign-up, language, maintenance, announcement, 2FA for all, audit and sign-in trails (CSV), support        |
| Interface      | English source + French locale (ADR 0041), light and dark themes, command palette, keyboard help, pinned bases and tables, recent tables; base settings                   |
| Accessibility  | Date, list, and rating editors on React Aria (ADR 0045); grid, record panel, and forms by keyboard; WCAG 2.2 AA checked by axe in the journeys                            |
| Client data    | PostgreSQL, MySQL, MariaDB, SQL Server tables read where they live, over verified TLS; formulas, lookups, rollups by each engine                                          |
| Client writes  | Edits, new rows, deletes, and file imports, compared under lock with what each person saw; three-step trail; refusals said line by line                                   |
| Client changes | Watched by a modification column or SQL Server Change Tracking: open grids, webhooks, and automations follow, once each                                                   |
| Client fields  | Fields people add to a client's table, kept in a side table of its database: edited even where the table is read-only, filtered, sorted                                   |
| Client seals   | Statuses and signatures on a client's rows, read-only tables included; a lock seals the values, and a change made elsewhere is told                                       |
| Synced tables  | A client's table read from a copy in AnyGridDB, refreshed every N minutes; added, changed, and deleted rows told; read-only                                               |

## Known limits

- Grouped grids load at most the first 1,000 rows of the view.
- Imports, exports, copies, and base snapshots stop at 100,000 rows. Export and snapshot files are kept for 24 hours.
- An interrupted job is not retried: its author starts it again.
- A view's settings that were saved again while one of its fields was in the trash lose that field's part; it comes back at the end of the view.
- A base snapshot names people by email: a user cell keeps the people who are members of the new base. Roles given by groups stay behind.
- A collaborator with field or row rules cannot use the row trash, and cannot import with updates by key under a row rule.
- Rows deleted before this release's many-to-many restore fix come back without those links.
- Single sign-on matches accounts by email, not by the provider's subject; the provider must verify addresses.
- The map view draws points on a plain SVG projection, without tiles.
- A synced table is as old as its last refresh, is read-only, stops at a million rows, and links to a table read live show empty.
- A locked client row is protected from AnyGridDB's writes only: a change another application makes is detected (within five minutes, seconds on a watched table) and told, not refused. Its seal covers every stored column, so a row put back still differs by its `updated_at`.
- Template content (table and field names) is English-authored with stable ids.
- On SQL Server a page is one query: a table with very many complex computed fields can exceed what SQL Server compiles, and AnyGridDB says so. There, MD5, SHA256, and SHA512 read texts of up to 100,000 characters, and JSON_EXTRACT reads a text value of up to 4,000.
- Regular expressions are a portable subset, written in the formula: `\d`, `\w`, and `\s` are ASCII, and back-references and lookbehinds are refused. SQL Server reads none before 2025, so there they are refused.
- JSON_EXTRACT needs PostgreSQL 16 or later, where a text that is not JSON can be told apart without failing the read. On MySQL it reads JSON numbers as doubles, and the field says so.

## Next

Phases 0 to 8 of the [migration plan](docs/migration-plan.md) are done;
the [decision records](docs/adr/README.md) say why each piece is as it
is. Still open, by value:

1. Client tables: AnyGridDB's own fields kept in AnyGridDB when the DBA
   grants no side schema.
2. A formula type checker apart from the SQL compiler, and incremental
   refresh for very large synced tables.
3. Read replicas per source; Oracle when a client needs it (ADR 0024).
4. Mark the CI workflow required in GitHub branch protection.

### Gaps against comparable products (2026-11-08)

Each is absent from the code today and shipped as open source by at least
one comparable product. In the proposed order: small engine items first,
then forms and views, the read engine, migration, integrations, and
enterprise operations.

1. Rollups: distinct sum and mean, standard deviation, and variance.
2. Formulas: regular expressions (match, extract, replace), working days,
   relative dates (from now, to now), date parsing, text before and split,
   even and odd, not blank, true and false, typed errors, hashes, JSON
   extraction, and array sort, slice, and flatten. An engine without the
   function says so (ADR 0027).
3. A `between` filter for numbers and dates.
4. Forms that show a field only when earlier answers match a condition.
5. A link field that offers only the rows of a chosen view or filter.
6. A private iCal feed for each calendar view.
7. Lookups and rollups over the linked rows that match a filter.
8. Import an Airtable base: tables, field types, links, views, and rows,
   with an error report.
9. An MCP server on the application services (ADR 0022), under the
   token's rights.
10. Automations: a row-deleted trigger, an incoming webhook trigger, a
    delete-row action, conditional branches, a loop over rows, and more
    than five actions.
11. SCIM 2.0: accounts and groups provisioned by the identity provider.
12. Base snapshots that carry attachments and user cells.

## Non-goals

- Copying the Nest/Nuxt modules procedure by procedure
- SDK, secrets CLI, and Helm in this tree
- AnyGridDB's own store on anything but PostgreSQL (ADR 0003). MySQL, MariaDB, and SQL Server come in as external sources (ADR 0006)
- A paid or enterprise build
- MinIO (abandoned upstream), or any non-OSI default
