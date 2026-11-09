# 0013 — Lingui, and stable error codes

- Status: Accepted
- Date: 2026-11-07

## Context

- Source strings were French, with a 1,000-line English dictionary.
  Superseded for the source language by [0041](0041-english-source-locale.md).
- Server errors are English sentences that the client translates with
  regular expressions (`apps/web/lib/i18n.tsx`, `PREFIXED`).
- There are no plural rules, and no catalog format translators can use.

This breaks at a third language.

## Decision

- **[Lingui](https://lingui.dev)** (MIT): compiled macros, ICU MessageFormat
  for plurals and dates, and PO catalogs that Weblate, a free software
  translation platform, can work on.
- **Server errors carry a stable code and parameters**, for example
  `{ code: "column.unknown", params: { name } }`. The client translates the
  code. No sentence is parsed.

## Rejected

- **Keeping the homemade dictionary.** It has no plurals, no extraction,
  and no format translators can use.
- **i18next.** A fine choice, but Lingui's compile-time macros keep the
  runtime smaller and the PO workflow simpler.
