## Summary

-

## Checklist

CI checks formatting, conventions, lint, types, tests, translation catalogs,
and commit messages. Check what it cannot:

- [ ] The change sits in the package that owns the job ([`ARCHITECTURE.md`](../ARCHITECTURE.md))
- [ ] New behaviour has a colocated test with an accepted and a refused case (or this is docs only)
- [ ] A changed user journey is covered in `apps/web/e2e`
- [ ] New UI text is in English and translated into French
- [ ] No secrets, `.env` files, credentials, or personal data in the diff

## Accessibility (UI changes)

Skip if this pull request does not change `apps/web` or `packages/ui`.
See [`ACCESSIBILITY.md`](../ACCESSIBILITY.md).

- [ ] Keyboard use works end-to-end on the changed flow
- [ ] Focus is visible and logical; no trap without an exit
- [ ] Forms have labels; errors are announced
- [ ] Colour is not the only way meaning is conveyed
- [ ] Reduced motion is respected if animation was added
- [ ] `accessibilityViolations(page)` stays empty in the journeys touched

## License

- [ ] This change is AGPL-3.0-or-later, or another OSI-approved license compatible with it.

## Test plan

- [ ]
