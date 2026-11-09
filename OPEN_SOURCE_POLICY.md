# Open-source & legal-safety policy

**Goal:** use, ship, and recommend **100% open-source** building blocks —
[OSI-approved](https://opensource.org/licenses) licenses — so contributors and
operators do **not** take on avoidable copyright / license litigation risk.

This is a **hard product rule**, not a slogan.

## Rules (MUST)

1. **Product license** — AnyGridDB itself is **AGPL-3.0-or-later** only.
2. **Default stack** — every component in the official `docker/` path MUST be
   OSI-approved (see table below).
3. **Dependencies** — libraries we vendor, bundle, or require at build/runtime
   MUST be under an OSI-approved license compatible with AGPL-3.0-or-later
   distribution of this project.
4. **No source-available traps** — do **not** add code or recommended servers
   under non-OSI “open” licenses, including (non-exhaustive):
   **SSPL**, **BSL**, **SUL**, **Fair Source**, **Commons Clause**,
   **Elastic License**, **Server Side Public License**, proprietary SDKs,
   or “free for non-commercial / evaluation only” terms.
5. **No paid feature locks** in our code — capabilities are open or on the
   public roadmap (`ROADMAP.md`).
6. **Refuse to guess** — if a license is unclear, treat it as **blocked** until
   verified against https://opensource.org/licenses.

## Allowed exception — interoperability

Connecting **to** a proprietary system the operator already runs (e.g. Microsoft
SQL Server as an external data source, reading `.xlsx` files) is allowed **only**
via an **OSI-licensed client** we ship. We do **not** redistribute proprietary
servers, drivers with non-OSI EULAs, or commercial “Pro” editions of libraries.

External sources (ADR 0006) follow this rule: `pg`, `mysql2`, and `tedious`
are MIT clients. The CI runs SQL Server from Microsoft's Developer image to
test the connector; that image is never shipped or recommended as a default.

## Official default stack (OSI)

| Piece      | Choice                                                                        | License                 |
| ---------- | ----------------------------------------------------------------------------- | ----------------------- |
| App        | AnyGridDB                                                                     | AGPL-3.0-or-later       |
| Database   | PostgreSQL 17 (18 in the target stack)                                        | PostgreSQL License      |
| Files      | Local disk by default; any S3 optional, RustFS in `compose.s3.yml` (ADR 0010) | Apache-2.0 (RustFS)     |
| Toolchain  | mise                                                                          | MIT                     |
| Containers | Docker Engine / containerd / Podman + Compose-compatible tooling              | Apache-2.0 / MPL / etc. |

**Prefer** Docker Engine CE, Podman, or rootless containerd — not a proprietary
desktop product as a **requirement**. Documented alternatives are fine.

## Explicitly out of the default path

| Product / pattern                                                                      | Why                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Non-OSI object stores / “community” editions with SSPL/BSL/AGPL traps that are not OSI | Legal surface                                                            |
| Proprietary desktop-only runtimes as the only install path                             | Lock-in + EULA risk                                                      |
| Commercial spreadsheet “Pro” libraries                                                 | Proprietary                                                              |
| License servers, phone-home entitlement checks                                         | Paid-lock pattern                                                        |
| Telemetry on by default                                                                | Privacy + vendor lock; SDKs must still be OSI if present, and **opt-in** |

## Known inherited debt (honest)

The optional S3 driver talks to RustFS or any S3 service with `@aws-sdk/client-s3`. It does not ship a MinIO server. Spreadsheets go through `exceljs` (MIT). Do not add SheetJS Community Edition, a MinIO client, or Sentry.

Two older rules were based on facts that changed:

- **Redis.** It was pinned to 7.2 because 7.4 moved to RSALv2/SSPL. Redis 8 has been available under AGPLv3, an OSI license, since May 2025. The pin is moot anyway: Redis left the stack (ADR 0009). Valkey (BSD) is the only candidate if a cache ever returns.
- **MinIO.** Its server is AGPL-3.0, an OSI license. It stays out because it was abandoned: its community edition went into maintenance mode in December 2025 and was archived in 2026.

Track removals or replacements in `ROADMAP.md` when a dep fails this policy.

## How to add a dependency or stack piece

1. Confirm the license is on the [OSI list](https://opensource.org/licenses).
2. Confirm AGPL-compatible redistribution for anything we ship in our images.
3. Prefer well-known permissive (MIT, Apache-2.0, BSD) or strong copyleft (GPL/AGPL) over novelty licenses.
4. Document the license next to the component (compose comment, `NOTICE.md`, or this file).
5. If unsure → **do not merge**.

## Related docs

- `NOTICE.md` — copyright / AGPL notice
- `CONTRIBUTING.md` — contributor hard rules
- `ARCHITECTURE.md` — default ops path (`docker/`)
- `ROADMAP.md` — no proprietary Enterprise overlay
