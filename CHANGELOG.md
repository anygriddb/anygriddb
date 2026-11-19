# Changelog

What changes for those who run or use an instance. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): until
1.0, a minor version may change what an operator must do, and says so
first.

## Unreleased

### Changed

- A form's bar keeps what acts on the table (undo, export, import,
  automations, the row trash) and no longer shows what chooses or
  arranges rows: fields, filter, sort, colour, search, and the button
  that adds a row. A form draws no row for them to act on.

### Removed

- A SQLite file is no longer read as a source (ADR 0107). It never
  showed a table that holds a text: such a table failed to open.
  **Before upgrading**, with the version in place, an administrator
  deletes the tables of a SQLite source from their bases, then from
  each base's trash, then the source itself, in Administration. The
  upgrade refuses to start while one is declared, says so, and changes
  nothing. `ANYGRIDDB_SOURCES_ALLOWED_PATHS` and
  `ANYGRIDDB_SOURCES_SQLITE_ALLOW_MEMORY` are no longer read.

### Fixed

- Where the keyboard is shows again on the buttons that open a menu,
  the button that closes a dialog, the days of a date picker, the
  buttons that edit a field in a row's panel, a kanban's cards, and the
  handles that move a card, an option, or a widget: they drew no focus
  ring.
- Behind a session, a page is the main part of its screen for a screen
  reader, and the keyboard's first stop, "Skip to the content", leads
  to it: the way to a page was through every base and table of the
  navigation.
- The sign of a page, a table, or a list that could not be read, and
  the marks of a provisioning token that is revoked or expired, are
  drawn in the colour that warns: they were in the text's own.
- In a kanban and a gallery, Enter or Space on a card opens its row
  and nothing else. It also picked the card up: the page stopped
  answering until Escape, and a second Enter dropped the card. A click
  in the very middle of a card did the same.
- A card carried from the keyboard onto the card below it lands after
  that card, and the move is undone as any other: it stayed where it
  was.
- A row's panel takes the keyboard when it opens beside a view, and
  Escape gives it back to the card, the day, or the cell it was opened
  from. From a card, the panel was reached only past every other card
  of the view.
- In a row's panel, Escape closes the list of people to mention and
  keeps the comment being written: it closed the panel.
- While a card or a widget is carried from the keyboard, the place
  offered takes the keyboard, is named for a screen reader, and keeps
  the keyboard once the card is dropped there.
- A calendar names each day in full for a screen reader, with that
  day's rows under it.
- A gallery's cards stay as they are when a row's panel opens beside
  them: each was drawn again, its picture with it.
- A timeline opens on today when its period holds it. At the scale of
  a year it opened on January, and the rows of the autumn were out of
  sight until the page was scrolled.
- A timeline's bar too short for its row's name is drawn bare: it
  showed the name's first letter, cut. The name is at the head of the
  line, and a screen reader still hears it on the bar.
- The runs of an automation say what started each in the words of its
  dialog, "A row is created" or "Run by hand": they showed a code,
  `row_created` or `manual`, in English whatever the language.

## 0.2.0 - 2026-11-17

**Before upgrading:** an instance that declared a source on the Redis
wire protocol, Cassandra, or Neo4j deletes it first, with 0.1.0 still in
place: the source's tables from their bases, then from each base's
trash, then the source itself, in Administration ("Removed", below).
The upgrade refuses to start while one is declared, says so in the
application's log, and changes nothing: 0.1.0 starts again on the same
data. Nothing else is asked of an operator.

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
- A change to a value someone else changed meanwhile is refused, on
  AnyGridDB's own tables as on a client's: the page says so and shows
  what the row holds. Two people changing different fields of a row are
  not stopped. Through the API, an update that sends `expected` is
  compared the same way and answers 409 `row_conflict`; one that does
  not is written as before (ADR 0103).
- The syslog collector is set in Administration, under Connections: its
  host, its port, and an authority's certificate when it needs one. It
  is saved once it took a test event, and needs no restart. A collector
  on a private network needs private networks allowed, under
  Notifications. One named in the instance's environment still wins, and
  is shown there (ADR 0105).

### Changed

- An upgrade that asks for a step first is refused before it changes
  anything: the application's log says "Upgrade refused" and what to
  do, and the version before starts again on the same data (ADR 0106).

### Removed

- The Redis wire protocol, Cassandra, and Neo4j are no longer read as
  sources (ADR 0104). **Before upgrading**, with the version in place,
  an administrator deletes the tables of those sources from their
  bases, then from each base's trash, then the sources themselves, in
  Administration: a source is not deleted while one of its tables is
  in a base or in its trash. The upgrade refuses to start while such a
  source is declared, and says so. The MongoDB wire protocol and
  OpenSearch are read as before.

### Fixed

- A value typed into a field of unique values that another row already
  holds is refused in those words, naming the field. The message spoke
  of making the field unique, and named an index.
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

### Operators

- Migrations 0115 to 0117 run at the first start, as every migration
  does. 0116 is the one that refuses a Redis, Cassandra, or Neo4j
  source.
- Scripts start a process of their own, four at once at most, each
  with up to 128 MiB of memory: leave the container that much beside
  what the application uses, or leave scripts off.
  `docker compose exec app anygriddb scripts check` says whether the
  process starts where the instance runs (`docs/operations.md`).
- A release is refused when a Node.js package of its image has a high
  or critical advisory with a fix, as it already was for the system's
  packages (ADR 0100).

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
