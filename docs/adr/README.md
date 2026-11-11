# Architecture decision records

Each record states one decision, why it was taken, what it costs, and what was
rejected. A record is never rewritten to say something else: a later record
supersedes it.

All records below were accepted on 2026-11-07, after a review that challenged
every piece of the stack on its merits, regardless of the code already
written. A second review the same day measured the code instead of
asserting: it superseded 0001 and added 0021 to 0026.
[`../migration-plan.md`](../migration-plan.md) records the phases that carried the work; every one is done.

| #                                                    | Decision                                                                                | Status                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------- |
| [0001](0001-typescript-end-to-end.md)                | TypeScript end to end                                                                   | Superseded by 0021                 |
| [0002](0002-two-planes.md)                           | Two planes: AnyGridDB's PostgreSQL, and the client's databases                          | Accepted                           |
| [0003](0003-postgresql-only-internal-store.md)       | AnyGridDB's own store is PostgreSQL only                                                | Accepted                           |
| [0004](0004-kysely-and-sql-migrations.md)            | Kysely, `pg`, plain SQL migrations, generated types                                     | Accepted                           |
| [0005](0005-multi-dialect-read-engine.md)            | A read engine with one compiler per SQL dialect                                         | Refusal rule amended by 0027       |
| [0006](0006-external-sources.md)                     | External sources: live reads and writes on the client's databases                       | Accepted                           |
| [0007](0007-guarantees-per-storage.md)               | What audit, locks, and signatures guarantee on native and external tables               | Accepted                           |
| [0008](0008-graphile-worker.md)                      | graphile-worker for events and jobs                                                     | Accepted                           |
| [0009](0009-no-redis.md)                             | No Redis                                                                                | Accepted                           |
| [0010](0010-file-storage.md)                         | Files on local disk by default, any S3 as an option                                     | Accepted                           |
| [0011](0011-vite-spa.md)                             | A Vite single-page app served by the API                                                | Accepted                           |
| [0012](0012-react-aria-and-dom-grid.md)              | React Aria Components and a DOM grid                                                    | Accepted                           |
| [0013](0013-lingui-and-error-codes.md)               | Lingui, and stable error codes                                                          | Accepted                           |
| [0014](0014-runtime-and-toolchain.md)                | Node 26, pnpm 11, compiled API, strict type-checked lint                                | Accepted                           |
| [0015](0015-authentication-libraries.md)             | Authentication libraries                                                                | Accepted                           |
| [0016](0016-field-and-row-rules-in-the-engine.md)    | Field and row rules are enforced by the read engine                                     | Implemented                        |
| [0017](0017-schema-per-base.md)                      | One PostgreSQL schema per base; links across bases deferred                             | Accepted                           |
| [0018](0018-observability.md)                        | Logs, Prometheus metrics, OpenTelemetry off by default                                  | Implemented                        |
| [0019](0019-deployment.md)                           | One image, offline install, no telemetry                                                | Accepted                           |
| [0020](0020-kept-as-is.md)                           | Pieces kept as they are                                                                 | Accepted                           |
| [0021](0021-typescript-end-to-end-measured.md)       | TypeScript end to end, argued from what is actually shared; CodeMirror 6 formula editor | Accepted                           |
| [0022](0022-application-services.md)                 | One application service layer under every transport                                     | Accepted                           |
| [0023](0023-exact-numbers.md)                        | Exact numbers: decimals and 64-bit integers travel as strings                           | Accepted                           |
| [0024](0024-sql-server-authentication-and-oracle.md) | SQL Server authentication and the Oracle dialect                                        | SQL Server part superseded by 0026 |
| [0025](0025-isolated-xlsx-parsing.md)                | XLSX files are parsed in an isolated worker                                             | Accepted                           |
| [0026](0026-source-connections.md)                   | Source connections: a dedicated account and verified TLS on every engine                | Accepted                           |
| [0027](0027-engine-limits-shown-not-refused.md)      | An engine's limits are shown, not refused                                               | Accepted                           |
| [0028](0028-writes-to-client-tables.md)              | Writes to client tables: compared under lock, recorded in three steps                   | Accepted                           |
| [0029](0029-https-only.md)                           | HTTPS only, with the instance's own authority when no certificate is given              | Accepted                           |
| [0030](0030-every-connection-encrypted.md)           | Every connection AnyGridDB opens is encrypted and verified                              | Accepted                           |
| [0031](0031-changes-made-elsewhere.md)               | Changes made elsewhere: told by a column or by Change Tracking                          | Accepted                           |
| [0032](0032-fields-added-to-client-tables.md)        | Fields added to client tables live in a side table of the client's database             | Accepted                           |
| [0033](0033-statuses-on-client-rows.md)              | Statuses and signatures on client rows: kept by AnyGridDB, sealed by a fingerprint      | Accepted                           |
| [0034](0034-synced-tables.md)                        | Synced tables: a copy in AnyGridDB, refreshed and compared                              | Accepted                           |
| [0035](0035-dashboard-charts.md)                     | Dashboard charts: aggregates by the source, drawn with ECharts                          | Accepted                           |
| [0036](0036-formula-errors.md)                       | Formula errors travel beside the value: blank in the cell, message in `ag_errors`       | Accepted                           |
| [0037](0037-airtable-import.md)                      | Airtable bases imported through Airtable's Web API, as a snapshot, with a report        | Accepted                           |
| [0038](0038-scim-provisioning.md)                    | SCIM 2.0: accounts and groups kept by the identity provider, groups give base roles     | Accepted                           |
| [0039](0039-snapshot-archives.md)                    | Base snapshots carry their files in a ZIP archive, and their people by email            | Accepted                           |
| [0040](0040-mcp-server.md)                           | An MCP server over HTTP, and an API page that tries requests itself                     | Accepted                           |
| [0041](0041-english-source-locale.md)                | English is the Lingui source language; French via PO / Weblate                          | Accepted (supersedes 0013 source)  |
| [0042](0042-instance-controls.md)                    | Instance controls: a sign-in trail, maintenance, a required second factor, support      | Accepted                           |
| [0043](0043-security-policy.md)                      | A security policy the administrator sets: locks, second factor, passwords, sessions     | Accepted (refines 0042)            |
| [0044](0044-account-policies.md)                     | Who creates bases and tokens, whom owners invite, idle accounts, lock alerts            | Accepted (extends 0043)            |
| [0045](0045-cell-editors-and-exact-numbers.md)       | Cell editors on React Aria; exact numbers stay text                                     | Accepted (amends 0012)             |
| [0046](0046-control-plane-enrichment.md)             | Enrichment without a side schema lives in the control plane                             | Accepted (amends 0032)             |
| [0047](0047-oracle-dialect-spike.md)                 | Oracle dialect: thin mode, shipped on the five-engine conformance suite                 | Accepted                           |
| [0048](0048-versions-and-releases.md)                | Versions and releases: SemVer in the root package.json, tags, labelled image            | Accepted                           |
| [0049](0049-realtime-gaps.md)                        | Realtime gaps: every page re-reads what it may have missed; heartbeat                   | Accepted (completes 0009)          |
| [0050](0050-operator-integrations-ui.md)             | Operator integrations (SMTP, OIDC, SAML) in the UI; env as optional bootstrap           | Accepted                           |
| [0051](0051-admin-account-erasure.md)                | Administrator-initiated account erasure; comments under the tombstone                   | Accepted                           |
| [0052](0052-operator-mail.md)                        | Operator mail: plain-text notice to all active or chosen accounts                       | Accepted                           |
| [0053](0053-sso-prove-and-sso-only.md)               | Prove SSO at save; SSO-only sign-in with admin break-glass                              | Accepted                           |
| [0054](0054-support-role.md)                         | Support role: helpdesk account ops without full admin                                   | Accepted                           |
| [0055](0055-signin-allowlist.md)                     | Sign-in address allowlist (CIDR) for interactive sessions                               | Accepted                           |
