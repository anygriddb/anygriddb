# Weblate and additional locales

## Current catalogs

| Path                              | Role                                         |
| --------------------------------- | -------------------------------------------- |
| `apps/web/locales/en/messages.po` | Source locale (identity: `msgstr` ≈ `msgid`) |
| `apps/web/locales/fr/messages.po` | French translations                          |

Lingui config: `apps/web/lingui.config.ts` — `sourceLocale: "en"`, `locales: ["en", "fr"]`.

## Weblate component (operator)

When hosting Weblate against this repository:

- **File mask:** `apps/web/locales/*/messages.po`
- **Source language:** English (`en`)
- **File format:** gettext PO
- **Base file:** `apps/web/locales/en/messages.po`
- **New language:** adds `apps/web/locales/<code>/messages.po`

Prefer Weblate pull requests over direct pushes to `main`. Do not edit the same
PO in git and Weblate in the same week without a lock.

After a Weblate PR lands, CI must pass `i18n:verify` and `apps/web` unit tests
(including French completeness).

## Third-locale readiness checklist

Do not ship a third UI language until each item is done and a maintainer owns it:

1. Add the code to `Locale` in `apps/web/lib/i18n.tsx` and to
   `defaultLocale` in `packages/core/src/instance.ts`.
2. Add the locale to `lingui.config.ts` `locales`.
3. Create `apps/web/locales/<code>/messages.po` (extract + translate).
4. Expose it in the language menu and admin instance settings.
5. Extend `apps/api/src/mail-i18n.ts` (or load shared catalogs) for system mail.
6. Add CI: non-empty `msgstr` and placeholder parity for the new locale.
7. Document the language owner in this file.

## Related

- ADR [0041](adr/0041-english-source-locale.md)
- [`i18n-glossary.md`](i18n-glossary.md)
