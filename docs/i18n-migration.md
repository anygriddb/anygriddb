# English-source i18n migration

Status: **implemented on `feat/english-i18n-source`** (ADR 0041).

## Inventory (at cutover)

| Item                          |                                       Count |
| ----------------------------- | ------------------------------------------: |
| Catalog messages              |                                      ~1,464 |
| Lingui-touched TS/TSX files   |                                         ~72 |
| Macro rewrites in the flip    |                                      ~1,698 |
| Base templates (English seed) |                                           4 |
| System mail modules           | notifications, invitations, webhook disable |

## Tooling

| Script                                      | Role                                                 |
| ------------------------------------------- | ---------------------------------------------------- |
| `node scripts/i18n/report.mjs`              | Catalog health (empty translations, placeholders)    |
| `node scripts/i18n/flip-source.mjs`         | One-shot French→English macro rewrite (historical)   |
| `node scripts/i18n/rebuild-catalogs.mjs`    | Fill `fr` msgstr from `.flip-map.json` after extract |
| `pnpm --filter @anygriddb/web i18n:extract` | Refresh PO from English macros                       |
| `pnpm --filter @anygriddb/web i18n:verify`  | CI: catalogs match sources                           |

Map file: `scripts/i18n/.flip-map.json` (`frToEn` / `enToFr`). Keep it until Weblate owns French updates; do not re-run `flip-source` on an English tree.

## Policy after cutover

1. New UI copy is English macros only ([`docs/i18n-glossary.md`](i18n-glossary.md)).
2. After changing messages: `i18n:extract`, then translate new `msgstr` in `locales/fr`.
3. System mail strings: `apps/api/src/mail-i18n.ts`.
4. Seed templates: English in `packages/core/src/templates.ts`.
5. Third locale: see [`docs/weblate.md`](weblate.md) checklist — do not add until a language owner exists.

## Remaining editorial work

English msgstr from the former catalog is the baseline. Pack-by-pack tone review against the glossary can continue without another source flip.
