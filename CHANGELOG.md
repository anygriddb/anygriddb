# Changelog

What changes for those who run or use an instance. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): until
1.0, a minor version may change what an operator must do, and says so
first.

## Unreleased

### Added

- An automation can run a script: a few lines of JavaScript among its
  actions, which read the row, read and write rows of the base with
  their author's access, and hand values to the actions after them. A
  script runs apart from the instance, with no network and no file, and
  is stopped after 10 seconds or at 64 MiB of memory. Scripts are off
  until an administrator allows them, in Administration under Security
  (ADR 0099). A script is written in an editor that colours it, numbers
  its lines, and indents a new line as the one before.
- A script calls a public HTTPS address with `fetch`: the instance makes
  the call, as it does a webhook's. An automation keeps the secrets its
  scripts send, each for one host; a secret is typed once, never shown
  again, and never given to the script itself (ADR 0101).
- An automation started by a call to its address can also be run by
  hand, from the list of automations.
- The options of a list are put in order from the field's dialog: each
  moves a place up or down. A cell offers them in that order, and a
  kanban lays its stacks out in it.

### Fixed

- The steps of an automation's run are numbered by their place: the
  second action of an automation was listed as its first.
- On a table where a field asks for a reason, deleted rows come back:
  the notice of a delete, an undo, and the row trash ask for the reason,
  where the first two did nothing and the trash refused. An undo or a
  redo that cannot be done says why.
- In the row trash, each box is named by its row for a screen reader.
- A cell chosen while a fill or a paste is being saved stays chosen:
  the selection no longer jumps back to what was filled or pasted when
  the save ends.
- The colour of an option, of a button, and of a colour rule is chosen
  among swatches large enough to point at, each named in the reader's
  language, the chosen one ticked. The button that adds an option has a
  name for a screen reader.

## 0.1.0 - 2026-11-16

First public release. The GitHub Release for `v0.1.0` holds the full
operator notes; this entry records what landed last before that tag.

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

- "About AnyGridDB", in the account menu, on the sign-in page and on
  public links' pages: the
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
