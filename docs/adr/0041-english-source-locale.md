# 0041 — English is the Lingui source language

- Status: Accepted
- Date: 2026-11-09
- Supersedes: the “source strings are French” clause of [0013](0013-lingui-and-error-codes.md)

## Context

AnyGridDB is open source and aimed at an international audience. Docs, ADRs,
core error codes, and most server code were already English. UI macros used
French as `sourceLocale`, with English only in `apps/web/locales/en/messages.po`.
That blocked non-French contributors from reading or writing UI copy, and made
a third language harder for Weblate (translators expect English `msgid`).

System mail and seed templates were hardcoded French. Anonymous public views
forced `locale="fr"` for number/date formatting.

## Decision

- **English is the Lingui source language** (`sourceLocale: "en"`). Authors write
  `` t`Create` `` / `` msg`Create` `` in `apps/web`. French lives in
  `apps/web/locales/fr/messages.po` and is maintained through PO / Weblate.
- **New instances default to `defaultLocale: "en"`**. Existing instances keep
  their stored setting. The browser still picks `fr` when `navigator.language`
  starts with `fr` and the person has not chosen a language.
- **System e-mail** (notifications, invitations, webhook disable notices) is
  rendered from `apps/api/src/mail-i18n.ts` using the instance `defaultLocale`
  (user preference when a column exists later). Automation `sendMail` bodies
  stay operator-authored.
- **Seed templates** (`packages/core/src/templates.ts`) are English-authored,
  keyed by stable ids (`crm`, `projects`, …). Display chrome for known server
  values stays in `apps/web/lib/known-text.ts`.
- **Error codes** stay as in ADR 0013: English messages for logs/REST; the web
  app translates from the code, never from the English sentence.
- **E2E** runs in English; one smoke path switches to French.

## Rejected

- **Keeping French as source “until more languages”.** A third locale is harder
  with French `msgid`; the English catalog already existed.
- **Blind PO swap without tooling.** Scripts under `scripts/i18n/` report,
  flip macros, and rebuild catalogs so the cutover is repeatable.
- **Rewriting user data** created from older French templates.

## Consequences

- CONTRIBUTING and ARCHITECTURE describe English macros; translators edit `fr`.
- CI requires a complete French catalog (non-empty `msgstr`, placeholder parity).
- Editorial polish of English tone continues under `docs/i18n-glossary.md`.
