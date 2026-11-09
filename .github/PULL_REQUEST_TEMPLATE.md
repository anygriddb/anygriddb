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

## License

- [ ] This change is AGPL-3.0-or-later, or another OSI-approved license compatible with it.

## Test plan

- [ ]
