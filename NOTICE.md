# AnyGridDB — NOTICE

AnyGridDB is free software licensed under the **GNU Affero General Public
License v3.0 or later** (AGPL-3.0-or-later), an
[OSI-approved](https://opensource.org/licenses) license.

## Policy

- The AnyGridDB product line does **not** use paid feature locks.
- Features are either available in the open source tree or tracked publicly in
  `ROADMAP.md` as work to implement — not as commercial entitlements.
- Contributions are accepted only under AGPL-3.0-or-later.
- Do not import code that is not under an OSI-approved license compatible with
  this project’s AGPL-3.0-or-later distribution.
- Prefer **100% OSI open-source** for dependencies and the official stack; avoid
  non-OSI “source available” licenses and proprietary components that create
  avoidable legal risk. Full rules: [`OPEN_SOURCE_POLICY.md`](OPEN_SOURCE_POLICY.md).

## Dependencies

Every dependency is under an OSI-approved license. Those added in the v2
cycle and the stack rewrite:

| Package                                                                                 | License    |
| --------------------------------------------------------------------------------------- | ---------- |
| `@simplewebauthn/server`, `@simplewebauthn/browser`                                     | MIT        |
| `@tanstack/react-query`, `@tanstack/react-virtual`, `@trpc/tanstack-react-query`        | MIT        |
| `react-aria-components` (dialogs, menus, tooltips, drag and drop)                       | Apache-2.0 |
| `@tanstack/react-router`, `vite`, `@vitejs/plugin-react`, `babel-plugin-react-compiler` | MIT        |
| `cmdk` (it brings `@radix-ui/react-dialog`), `sonner`                                   | MIT        |
| `kysely`, `pg`, `graphile-worker`, `@fastify/static`                                    | MIT        |
| `lucide-react`                                                                          | ISC        |
| `@fastify/multipart`, `@fastify/rate-limit`, `exceljs`                                  | MIT        |
| `sharp` (its prebuilt `libvips` binaries are LGPL-3.0-or-later)                         | Apache-2.0 |
| `mysql2`, `tedious` (client databases)                                                  | MIT        |
| `oracledb` (Oracle client databases; thin mode; Apache-2.0 elected from dual license)   | Apache-2.0 |
| `@lingui/core`, `@lingui/react`, `@codemirror/*` (formula editor)                       | MIT        |
| `@modelcontextprotocol/server`, `@modelcontextprotocol/node` (MCP server)               | Apache-2.0 |
| `hono`, `@hono/node-server` (used by the MCP server)                                    | MIT        |

`packages/core/src/query/windows-zones.ts` is generated from the Unicode
CLDR file `windowsZones.xml`, Copyright © 1991-2013 Unicode, Inc., under
the Unicode License v3 (OSI-approved).

## Copyright

Copyright notices appearing in source files remain those of their respective
authors and contributors. Preserve them when you modify or redistribute the
software, as required by the AGPL.
