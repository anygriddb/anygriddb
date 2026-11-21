# Changelog

What changes for those who run or use an instance. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): until
1.0, a minor version may change what an operator must do, and says so
first.

## Unreleased

### Fixed

- "Duplicate field" works on a table of a client's database: the copy
  is one of AnyGridDB's own fields beside the client's rows, and holds
  what the field held. The copy was made empty, and the page read
  "Invalid row id".
- A view opened by a public link scrolls from the keyboard: the region
  that holds its rows takes the keyboard, and shows that it has it. A
  view drawn as cards holds nothing to focus, so more rows than the
  window shows were reached with a pointer only.
- Email settings a mail relay refuses say why: nothing answers at
  this host and port, the connection cannot be encrypted and verified
  (no STARTTLS, a certificate the instance does not trust, a port that
  speaks no TLS), or the account is refused. Each read "Invalid email
  settings: check the host, port, and password", whichever it was.
- The functions of a formula, in a field's dialog, are 24 pixels to
  press, as WCAG 2.2 asks: they were sixteen tall, in rows four pixels
  apart.

## 0.3.2 - 2026-11-21

**Before upgrading:** nothing to do.

### Fixed

- On a phone a map stands over the list of its points, each as wide as
  the page. Beside its list, the map was a strip a hundred pixels wide.
- On a phone a timeline's column of names leaves the axis most of the
  page: it took more than half of it. At every width, a bar of a day or
  two is opened by a width a pointer finds: at the scale of a year it
  was four pixels wide, and that was all there was to press.
- A calendar shows a day's events whole. On a phone, or in a window
  too short for the month, a week kept the height left to it: a day's
  fourth event was cut by the day's edge and the next were not drawn,
  with nothing to say they were there. A week is now as tall as its
  fullest day, the month scrolls, and an event is 24 pixels to press.
- On a phone, the bar over a page carries the name an administrator
  gave the instance, as the navigation and the sign-in page do: it
  wrote "AnyGridDB" whatever the instance was called.
- A row's panel draws a checkbox that was never ticked as a box not
  ticked, and a rating never given as none of its stars. Each showed an
  empty line under its name, with nothing to say a click ticks or
  rates.
- A card and a line of a list draw a checkbox that is not ticked as an
  empty box: its name stood over nothing, where a switch drew "off" and
  a yes or no said "No". A view shared by a link, drawn as cards, leaves
  out a field that holds nothing, as the app's cards do: it listed
  every name, most of them over an empty place.
- Revoking a public link, of a view or of a base, and revoking an API
  token of one's own ask first, and say what stops: one click did it,
  for everyone who had the link and for whatever used the token, and
  neither is made again. Administration already asked. Their lists
  write a day as every screen does ("20/11/2026"), where they showed
  the first ten characters of an instant.
- A page of a base that is not shared with its reader says so, as the
  base's own page did: its settings, its dashboards and its API page
  stayed blank, and its activity and its tables offered to "Try again"
  what the server had refused. A table or a dashboard that is not
  there is said so too. Nothing is asked about a base or a table the
  reader's own list does not hold.
- Deleting a dashboard asks first, and says its widgets go with it:
  one click on its bin deleted it, and nothing brings a dashboard back.
  Each bin of the list is named after its dashboard. Deleting an
  automation asks first too: its steps, the secrets it keeps, and the
  record of its runs went with one click. The buttons of an
  automation's line say what they do.
- A webhook's delivery log follows its deliveries while it is open:
  it is read again every few seconds. Read once, it missed a delivery
  written a moment after its row, and went on saying "Retry scheduled"
  of one that had since been sent, until it was closed and opened
  again.
- A chart of several lines, or of several areas, names each of them in
  its legend. The names were all drawn on one corner, one over the
  other, with no mark beside them: nothing said which line was which.
- A view that is not there is said to be one: "View not found". A
  dashboard's widget whose view went to the trash, an export, a link, a
  calendar's feed and the API's `view` each answered "Row not found"
  (`no_row`; the code is now `unknown_view`). A widget that shows
  such a view says so once: its page asked for the view's rows and was
  refused, again each time a row of the table changed.
- Taking a member out of a base, from its settings, asks first: one
  click on the bin took their role and the permissions set for them on
  each table, which inviting them again does not bring back.
  Administration already asked. Each bin is named after its member. A
  pending invitation that could not be revoked says why.
- An owner who lowers their own role on a base is asked first, and
  told that only another owner can give it back: one change of the
  list in the base's settings did it at once. The page then asks for
  nothing its reader may no longer read.
- Administration's change trail lists what a change touched without
  the columns every row has. A row's creation read "ag_created_at,
  ag_created_by, the row's place, ag_status" before the fields it was
  given, and a deletion the same: who wrote and when are the line's
  own, and a row's status and place are named, in words, when they
  change.
- An account that must set up a second factor first, as a new
  instance's first administrator must, no longer asks for the lists
  every page shares before it has one. The server refused each: five
  warnings in the instance's log on the first page of a new install,
  and an error in the browser's console. Until the factor is there the
  navigation holds the account's menu alone: the search, "New base",
  Administration and the bell led to what the server refuses, and the
  account's page no longer asks for the notifications' setting.
- Adding the object store to an instance that runs
  (`-f compose.yml -f compose.s3.yml up -d`) no longer stops it. The
  stack's internal authority was made again with a new key to cover
  the new service, PostgreSQL went on serving the certificate of the
  old one, and AnyGridDB refused it and restarted without end until
  PostgreSQL was restarted by hand. The authority's certificate is now
  renewed with the key it has, when a service joins the stack and in
  its last year: what runs stays verified, and nothing needs a
  restart.
- A dialog whose action is refused says so once and stays open, and
  the instance is no longer told that a page failed. An address typed
  wrong in "Delete the account", or the proof given up before an
  account's action, was reported to the operator as a failure in a
  browser. Giving the proof up before an emergency switch showed an
  error: it now leaves things as they were, with nothing to say.
- A row is added to a view that filters on a field with nothing typed
  yet. "Filter by this field", in a field's menu, keeps the condition
  as soon as it is chosen: until a value was typed, "Add a row" was
  refused with "Invalid cell" for any field but a text, since the new
  row took the empty value of the condition. A new row now takes from
  the view's filter only what its fields accept.
- The files of the app itself no longer count in the limit of requests
  per address. A first page asks for a hundred of them: some sixty
  people behind one address, opening the app after an upgrade, used up
  the three thousand requests a minute their pages share, and the next
  were refused the scripts themselves. What a page asks of the server
  is counted as before.
- A page whose scripts do not arrive says so after a few seconds, in
  the reader's language, and offers to reload: it stayed blank, with no
  word, when a script was refused or lost on the way.
- Small controls are 24 pixels to press, as WCAG 2.2 asks: each part
  of a date as it is typed (an empty day in French, "jj", was 12 pixels
  wide), the button that folds a group in a grid, an option of a
  filter's list, and the navigation's small buttons (pin, menus). A
  link in a sentence of Administration is underlined: in the dark theme
  its colour alone did not tell it apart.
- A request that is not signed in is told so before anything is looked
  up for it. Thirty-six operations given the id of a view, a dashboard,
  a webhook, a comment, an automation, a folder, a link or a restore
  point found what it named first: their answer told a stranger whether
  the id named anything, and nothing more. The list of a new base's
  templates answered anyone, and now answers a person signed in.
- A dashboard's widget made without a place stands under the others,
  at the size of its kind, and one that is changed without a place
  keeps where it stood. The page always says where; a script that did
  not made every widget at the top-left corner, one over another, and
  moved back there a widget it only renamed.

## 0.3.1 - 2026-11-20

**Before upgrading:** nothing to do. A restore point or a backup file
made before this version holds no dashboard: make a new one once
upgraded.

### Added

- Administration says when each base was last used, in the list of
  bases and on a base's page, where each of its tables has its date
  too: the newest change or export the trails hold, the rows written
  in a client's database among them. Reading a table leaves no trace
  unless its manager records who opens it, and the page says so.
- A dashboard's figure reads the last value of a field: what the field
  holds in the row that comes last by a date or a number and, of
  several rows that share it, in the one added last. A balance is read
  on its latest day, where it took a view made to keep that row. A row
  where either field is empty is passed over.
- A base's settings set the rows a member sees on a table: every row,
  or only those that match conditions, where "Me" in a collaborator
  field keeps each person to their own rows. The rule was kept and
  enforced everywhere, and no screen set it.
- A dashboard follows its tables. Once the rows of a table change, the
  figures, the charts, and the views' rows that read it are read
  again, a moment later and once for a burst of changes. A dashboard
  read when it was opened, and went on showing what was true then.
- A base's dashboards come with it: in its backup file, in a copy of
  the base, and in a restore point. Each widget reads the new base's
  own table and view. All three came back without a single dashboard,
  and nothing said so. A widget that reads a table of a source or a
  personal view, which a file does not hold, is left out, and the
  import says how many were. A file from a base that has dashboards
  is not read by an earlier version. The base's settings now say what
  stays behind: comments, the history of changes, automations,
  webhooks, and public links.

### Fixed

- On a phone a calendar's bar goes on to a second line. The list of
  the field it places rows by was cut at the screen's edge, and
  "Subscribe" was out of reach.
- The count of bases active over thirty days takes in a base whose
  rows are written in a client's database, and leaves out a base in
  the trash: it counted neither as it should, so that it could show
  more active bases than the instance had.
- Importing a base from its file counts the members it can give
  their role back to without the person importing it, who owns the
  base they make. A file that named them alone still asked whether to
  give "the member" their role back, which did nothing.
- Deleting a webhook asks first, and says its delivery log goes with
  it: one click deleted it. In the list a webhook's channel is named
  as its form names it ("Email", not "SMTP"), its three buttons say
  what they do, and no signing secret is shown for a webhook by email,
  which signs nothing.
- A row added from the bar of a calendar or a timeline takes a day the
  view shows, today when the month or the period shown holds it and
  its first day otherwise: the view shows the row it just made. The row
  was made with no date, and neither view showed it.
- A dashboard's figure or chart measures the field its form shows.
  Once another table or another measure was picked, the form kept the
  field chosen before, and saved a widget of a field its table does not
  have, which read "Unknown field". A figure's form now asks for the
  measure, then for the field, as a chart's does; a measure lists the
  fields it can read, the number a formula or a rollup answers among
  them, and says so when the table has none.
- "View as", in a base's settings, shows the table as the member
  reads it: their role in words and the first rows, with the fields
  they may read under their labels. It gave the role's identifier and
  the fields' internal names, answered nothing until a member was
  picked by hand, and offered the table's owners, whom no permission
  restricts. A field's permission is read whole in its list, where it
  was cut. A field added after a member's permissions were saved with
  every field read and written is no longer hidden from them.
- A cell that holds several options, linked rows, or people reads as
  it is named. Its chips ran together in the page's text ("RedGreen"),
  which the cell's name ("Tags: Red, Green") does not hold: someone who
  speaks to the page says what they see.
- A base made from a template dates its sample rows from the day it
  is made: a deal that closes this week, a project under way, sessions
  tomorrow. They were written as dates, so the calendar of the events
  template already opened on an empty month, and every task would have
  been overdue a few months on.

## 0.3.0 - 2026-11-20

**Before upgrading:** an instance that declared a SQLite file as a
source deletes it first, with 0.2.0 still in place: the source's tables
from their bases, then from each base's trash, then the source itself,
in Administration ("Removed", below). The upgrade refuses to start
while one is declared, says so, and changes nothing.

### Added

- A dashboard's widget for a view shows the view's rows: the first
  twenty, with the fields the view shows, in its order, under its
  filter and its sort, as the reader may read them. A row's name opens
  the row in its table, and a link opens the view. The widget only
  pointed to the view.
- A chart's categories are put in order by their value, the largest
  first, or left in their field's own; a chart draws the first of
  them, as many as its maker says, and counts the rest. With them, a
  chart of the fifteen largest of a hundred is two settings.
- A chart groups dates by their week, month, quarter, or year, each
  named by it ("Mar 2026", "Q1 2026"), on a client's database as on
  AnyGridDB's own: it grouped them by day only, and a month needed a
  formula field.
- A chart's series that add up are drawn side by side when its maker
  says so, where they always stood one on another: what came in and
  what went out are compared, not summed.

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

- A name takes the signs people write. A base, a table, a view, a
  folder, a dashboard, a widget, a group, or a person is named
  "Dépenses > 100 €" or "Revenus, par mois": a name was refused for a
  sign of money, a comma, a percent sign, a long dash, or the
  apostrophe a keyboard types. A name still holds a letter or a digit,
  and one line. An account an identity provider sends, and what an
  Airtable base brings, keep their signs too.
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
- A date reads the same on every screen, the day first and on 24
  hours, in the language the app is read in. The lists of
  Administration (accounts, sessions, sign-ins, changes, tokens,
  links), an automation's runs, a webhook's deliveries, the trash, and
  the bell followed the browser's own habit: on one set to it, the 3rd
  of April was written 4/3 there and 03/04 in a grid.
- A dashboard's widget for a view is added with the view its list
  shows: on a table with one view, or for the first of several, it was
  refused as "Invalid view", the list showing a view that had not been
  taken.
- The role between editor and viewer is named "Commenter" wherever a
  role is chosen or shown, as invitations name it: it read "Comment",
  and in French the verb.
- In a row's history and in what a base, a view, or a field held
  earlier, a space parts what was done from when: a screen reader read
  "created19/11/2026".
- A web address or an email among a card's fields is a link again for
  the keyboard and a screen reader, on a kanban, a gallery, and a
  phone's cards: the whole card was one button around it. A card is
  named by its row, where a screen reader heard every field in the
  button's name.
- On a phone, a dashboard's widgets stand one under another, each as
  wide as the screen, and its name is read whole: a widget kept its
  share of twelve columns, a quarter of the screen for a figure.
- A dashboard's figure and a chart's values are written as the field
  they measure is: a sum, a mean, or an extreme of a field of euros
  reads `1 234,70 €`, on the chart's axis and in its table of values
  too, where it read `1 234,7`. A figure of a field's earliest or
  latest date reads as a date.

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
