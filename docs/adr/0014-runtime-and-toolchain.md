# 0014 — Node 26, pnpm 11, compiled API, strict type-checked lint

- Status: Accepted
- Date: 2026-11-07

## Decision

| Piece             | Today                                                  | Decision                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js           | 22 (end of life April 2027)                            | 26, LTS since October 2026 (end of life April 2029)                                                                                                                                                                                                                                                  |
| API in production | `tsx` at runtime, compilers in the image               | Bundled with esbuild (our code and the workspace packages; npm packages stay external, and the build fails if one is not declared); migrations ship next to the bundle; multi-stage images without compilers, running as `node`. pnpm is installed with npm: Node 25 and later ship without Corepack |
| pnpm              | 9.15                                                   | 11, configured in `pnpm-workspace.yaml`, with `minimumReleaseAge` at seven days and an explicit `allowBuilds` list; no hoisting. pnpm 12, a Rust rewrite released in August 2026 that keeps pnpm 11's settings and lockfile, follows once it has matured                                             |
| Turborepo         | 2.11, telemetry on                                     | Kept, telemetry off in the repository                                                                                                                                                                                                                                                                |
| TypeScript        | 6.0                                                    | Kept; 7.0 as soon as typescript-eslint supports it                                                                                                                                                                                                                                                   |
| Lint              | `typescript-eslint` `recommended`                      | `strictTypeChecked`: catches floating and misused promises, a real source of server bugs                                                                                                                                                                                                             |
| Formatting        | Prettier                                               | Kept                                                                                                                                                                                                                                                                                                 |
| Unused            | `@tanstack/react-table` is declared and never imported | Removed                                                                                                                                                                                                                                                                                              |

## Consequences

- The first install under the seven-day rule found 20 of the 65 direct
  dependencies pinned to versions published less than a week earlier, some
  only hours earlier. They went back to the newest release of the same major
  that is at least a week old, and the lockfile was resolved again from
  scratch.
- The bot that opens dependency updates waits seven days too. It was
  Renovate, with a configuration copied from another project; Dependabot
  now does it for every ecosystem, with a seven-day `cooldown`
  (`.github/dependabot.yml`).

## Rejected

- **Bun or Deno as the runtime.** See ADR 0001.
- **tsdown.** Planned first, but it had 214 releases, the last one a day old, and no 1.0. esbuild is stable and already in the tree; a server bundle needs nothing more.
- **Node's built-in type stripping in production.** It would require `.ts`
  import extensions and erasable syntax only. A bundle starts faster and
  ships less.
- **Biome or oxlint instead of ESLint.** Their type-aware rules are not yet
  on par with typescript-eslint.
