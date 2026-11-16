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

Every dependency AnyGridDB ships, in its image and in the app's bundle,
is under an OSI-approved license, and `pnpm check` refuses one that is not
(`scripts/check-licenses.mjs`). The one exception, data that a build tool
reads and that is not shipped, is named in
[`OPEN_SOURCE_POLICY.md`](OPEN_SOURCE_POLICY.md).

The whole list, with the text of each license, is written when the app is
built (`scripts/third-party-licenses.mjs`) from what was installed: every
instance serves it at `/third-party-licenses.txt`, beside AnyGridDB's own
license at `/license.txt`, and "About AnyGridDB" in the app links to both.
The main ones:

| Package                                                                                 | License    |
| --------------------------------------------------------------------------------------- | ---------- |
| `@simplewebauthn/server`, `@simplewebauthn/browser`                                     | MIT        |
| `@tanstack/react-query`, `@tanstack/react-virtual`, `@trpc/tanstack-react-query`        | MIT        |
| `react-aria-components` (dialogs, menus, tooltips, drag and drop)                       | Apache-2.0 |
| `@tanstack/react-router`, `vite`, `@vitejs/plugin-react`, `babel-plugin-react-compiler` | MIT        |
| `cmdk` (it brings `@radix-ui/react-dialog`), `sonner`                                   | MIT        |
| `kysely`, `pg`, `graphile-worker`, `@fastify/static`                                    | MIT        |
| `lucide-react`                                                                          | ISC        |
| `@fastify/multipart`, `@fastify/rate-limit`, `@fastify/compress`, `exceljs`             | MIT        |
| `sharp` (its prebuilt `libvips` binaries are LGPL-3.0-or-later)                         | Apache-2.0 |
| `mysql2`, `tedious` (client databases)                                                  | MIT        |
| `oracledb` (Oracle client databases; thin mode; Apache-2.0 elected from dual license)   | Apache-2.0 |
| `mongodb` (stores that speak the MongoDB wire protocol; it brings `bson`)               | Apache-2.0 |
| `@lingui/core`, `@lingui/react`, `@codemirror/*` (formula editor)                       | MIT        |
| `@modelcontextprotocol/server`, `@modelcontextprotocol/node` (MCP server)               | Apache-2.0 |
| `hono`, `@hono/node-server` (used by the MCP server)                                    | MIT        |
| `uqr` (the code an authenticator app scans)                                             | MIT        |

`packages/core/src/query/windows-zones.ts` is generated from the Unicode
CLDR file `windowsZones.xml`, Copyright © 1991-2013 Unicode, Inc., under
the Unicode License v3 (OSI-approved).

## Copyright

Copyright notices appearing in source files remain those of their respective
authors and contributors. Preserve them when you modify or redistribute the
software, as required by the AGPL.
