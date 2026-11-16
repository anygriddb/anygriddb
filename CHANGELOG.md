# Changelog

What changes for those who run or use an instance. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): until
1.0, a minor version may change what an operator must do, and says so
first.

## Unreleased

No version is published yet. This section lists what changed since the
tree was last checked for a first release; it becomes that release's
notes.

### Security

- Guesses at an account's password or codes take turns, and a request
  carries one credential check at most: sign-ins sent together in one
  request no longer try more passwords than the lock allows (ADR 0095).
- A public link's password travels in the request's body, never in an
  address a proxy would log.
- An application's token endpoints count toward the sign-in limit per
  address. A refresh token used twice at once gives one pair of tokens.
- The page where a person allows an application sends its answer only to
  an address the application registered.

### Added

- "About AnyGridDB", in the account menu and on the sign-in page: the
  license, the absence of warranty, the source, and the licenses of the
  libraries the app is built with, which every instance now serves
  (`/license.txt`, `/third-party-licenses.txt`, ADR 0096).
- The image declares its own health check.
- An application finds the grant's addresses at
  `/.well-known/oauth-authorization-server` and may prove itself with
  the `Authorization: Basic` header; a client that does not is answered
  `invalid_client` (ADR 0098, `docs/integrations/oauth.md`).

### Changed

- A page far down a large table, and a page of a sorted one, are read
  several times faster on PostgreSQL: on a million rows, the page at the
  500,000th row went from 542 ms to 48 ms, and a sort from 403 ms to
  62 ms.

### Fixed

- An administrator who registered an application can be deleted; the
  application stays (migration 0113).
- Deleting an account no longer reads the whole change trail (migration
  0114).

### Operators

- Migrations 0113 and 0114 run at the first start, as every migration
  does. 0114 builds an index on the change trail: on a trail of many
  millions of events the start takes that much longer, once.
- Someone who runs a version they changed names their own repository in
  `SOURCE_URL` before building (`docs/operations.md`).
