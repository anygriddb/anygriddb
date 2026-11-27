# Changelog

What changes for those who run or use an instance. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): until
1.0, a minor version may change what an operator must do, and says so
first.

## Unreleased

**Before upgrading:** read Administration › People › Rights to review with
0.11.2. This upgrade (migration 0150) refuses until an operator accepts the
cases it lists: set `ANYGRIDDB_ACCEPT_UPGRADE=0150` in `.env`, start again,
then remove it. An instance that gives roles on tables, or field and row
rules, and runs a version before 0.11.2 upgrades through 0.11.2 first.

### Breaking

- A new public link or calendar feed ends: at the instance's longest life
  of a token (Security, "A token, a link or a feed lives at most") when
  none is chosen,
  and a link may not be made to last longer. Links and feeds made before
  keep no end until they are made again (ADR 0131). An automation's
  address does not end: it lives with its automation.
- Roles add up (ADR 0131). What someone may do on a table is what its base
  and the table give them together, by their own roles and their groups':
  a role given on a table only adds, and no longer takes away what the base
  gives. Everyone keeps exactly what they held on every existing table,
  but in the cases Rights to review listed, which the upgrade carries out:
  a table narrowed under a manager's role or a group's now gives that role
  too; someone a rule bound holds a role on each table of the base instead
  of one on the base; a base's role narrowed on some tables falls to what
  they share (one of the four, a role an administrator made of exactly
  those permissions, or one the upgrade makes, named "Floor of …").
  Rights to review goes with the cases it listed.
- A field or row rule narrows only the role it comes with: it is set on
  someone who holds a role on the table and none on its base. Setting one
  on someone the base reaches is refused (`rule_needs_table_role`).
- A role that gives a token no way in (`api.access`) no longer keeps a
  token out of a table that another role opens to it.
- Reading rows through a token or an application asks **Export**
  (`data.export`) besides **Reach by a token** (`api.access`): a table read
  a page at a time is an extraction (ADR 0131). The four shipped roles give
  both, so nobody who holds one loses anything; a made role with the way
  in and without Export no longer reads rows by a token, and still writes
  them. Tick Export on it to keep its scripts reading. The API console in
  a session reads as before.
- A token kept from deleting holds every permission but deleting rows
  (`rows.delete`), wherever it acts: it brings nothing back from the trash
  either. A script that restores rows needs a token made without that
  switch.

### Added

- Administration › Sharing › **Access** lists everything that reaches
  the instance without a session, whatever its kind: API tokens and
  applications, the tokens of the administration API and of provisioning,
  calendar feeds, public links and automations' addresses, each by its
  author, reach, end, last use and state (live, ended, revoked, or
  suspended while its author is disabled or no longer may), revoked from
  there (ADR 0131). Webhooks and automations, which act as their authors,
  have the page beside it. A base's page lists its addresses too.
- Three more shipped roles of a base (ADR 0131, migration 0154):
  **Reader** reads and comments and takes nothing out of the base;
  **Contributor** reads, comments, writes, deletes, takes a circuit's
  steps and imports, without exporting or publishing; **Validator**
  reads, comments and takes the steps a circuit gives validators. None of
  them reaches the base through a token. A circuit's step may name
  contributors and validators beside owners and editors.
- Administration › People › Roles offers **Duplicate** on every role, the
  shipped ones included: a new role of the same permissions, to change,
  since a shipped role never is (ADR 0131).

### Changed

- What acts without a session is one table, `delegated_accesses` (ADR
  0131, migration 0155): a person's API tokens, the applications they let
  in, and the tokens of the administration API and of provisioning
  (SCIM), moved row for row, ids, dates and hashes kept, nothing issued
  again. A revoked token stays, revoked, and acts on nothing; making and
  revoking a person's token or an application's grant is now on the
  change trail, never its secret. An application's renewal keeps its
  grant, with a new secret.
- Calendar feeds, public links and an automation's inbound address join
  them (migration 0156), moved row for row, ids, dates, hashes, a link's
  password and settings kept, nothing issued again. A revoked feed stays
  revoked beside a new one. An inbound address whose automation has no
  author any more, which ran nothing, is not kept. A handed-over
  automation's address follows it to its new author. Administration ›
  Trails names each access by its kind.
- Administration › People › a person's bases › **Effective rights** say
  every permission held on the base and on each table, and each
  attribution it comes from: their own or a group's, on the base or the
  table, until when, with a rule or not; a table says when its rules keep
  some rows or some fields from them (ADR 0131).
- **Rights at a past date** say what a made role gave at that date, as
  the change trail kept it, not what it gives now; their CSV ends with a
  column `permissions`, the keys of what each line's role gave.
- Administration's five roles (administrator, support, auditor, account
  manager, source manager) are attributions at the instance, as a base's
  roles are (ADR 0131, migrations 0151 and 0152): every role an account
  held is kept, and each change of one is on the change trail beside the
  sign-in trail. `ADMIN_EMAILS` and `anygriddb admin recover` give the
  administrator's role the same way.
- A group's role on a base is kept once, and reaches whoever is in the
  group when it is asked, instead of a copy for each member.
- Rights at a past date read, for a date before the upgrade, the roles as
  they stood then.
- Notices about a base go to whoever runs it, a made role that manages it
  or a group's included, and no longer to the four's owners alone.

### Fixed

- On a phone, a person's bases in Administration keep their name beside a
  role a group gives them: the role goes to the next line.
- A job a token started (an export, an import, a copy, a restore) acts by
  that token each time it runs, within what the token was given and what
  its author holds then (ADR 0131, migration 0153): a revoked or ended
  token stops it, where it went on with all its author's roles.

## 0.11.2 - 2026-11-26

Before upgrading: nothing to do. Migration 0149 runs by itself. Then read
Administration › People › Rights to review: the next minor version changes
how roles combine, and lists there, with this version, whose access it
will not keep exactly as it is.

### Added

- Administration › People › Rights to review lists, ahead of the next minor
  version, whose access that version will not keep exactly as it is (ADR
  0131, migration 0149). From then on roles add up: a role given on a table
  only adds to what its base gives, and a field or row rule narrows only the
  role it comes with. Everyone keeps what they hold on every existing table,
  but where a table's role or a rule narrows a base's role of someone who
  manages the base, or a role a group gives, and where a base's role must
  be lowered for its tables to keep what they gave. Each case says whom,
  where and what changes, so that an administrator can change it with this
  version or accept it. The next minor version's upgrade counts the same
  cases and stops until an operator accepts them; an instance that holds a
  table's role or a rule upgrades through this version first.

## 0.11.1 - 2026-11-26

Before upgrading: nothing to do. Migration 0148 runs by itself. An
administrator who had turned off the alert of a locked account in
Administration keeps it off, now in their notification preferences.

### Changed

- Whether an administrator hears of an account that locks, and how, is one
  of their notification preferences, as every other notice is; Administration's
  alerts no longer offer a second switch for it (migration 0148). An
  administrator who had turned it off there keeps it off.
- A rating or a duration on a client's floating-point column reads as a
  number field does: an infinity or a NaN reads empty and is said beside
  the value, where PostgreSQL 13 refused the whole page. A text-like field
  on MySQL's JSON or long text reads as its text, as a text did.

### Fixed

- A synced client table could lose a row from its copy when the client
  deleted another row while the copy was read: the row was told deleted to
  open grids, webhooks and automations, and came back at the next refresh.
  Each page of the copy now starts after the last row read, by its key.
- Files sent together could all be taken past a base's or an account's
  storage quota, each counted without the others. The room is now asked
  again as each file is recorded, one after the other, and a file refused
  then leaves nothing in the store.
- An import that finds rows by their key could add a row a second time,
  and an export leave one out of its file, when another row was deleted
  while they read the table: a table is now read whole as it was when the
  read began. An import line whose row was deleted meanwhile is refused on
  its own line; the rest of the import is written, where it used to stop.

## 0.11.0 - 2026-11-26

Before upgrading: an identity provider reached at the machine's own address
(localhost, 127.0.0.1) or at a cloud's metadata address is now refused, as
any call out of the instance is. Name it by an address of its network; a
provider on a private network is reached as before. Migrations 0146 and
0147 run by themselves; every limit keeps its value of 0.10.2, and no
quota is set.

### Changed

- Support, or a part of Administration given apart, asking for a change
  only an administrator makes is refused at once, no longer after a proof
  it could not use.
- An import that makes a base (a workbook, a snapshot, a base from another
  product) asks, when it runs, whether its author may still make a base: one
  queued before base creation was kept to administrators is refused.
- The identity provider (its discovery, its keys, the sign-in's exchange,
  the proof when its settings are saved), the release check and the import
  from another product are reached through the outbound service: each
  answer has a ceiling, and an address reserved for the machine or a
  cloud's metadata is refused. A provider on a private network is reached
  as before.
- Where an administrator allowed private networks, a name of that network
  (`.internal`, `.local`) is reached too, its address checked as any other.
- The grid, a row's panel and the gallery offer what a row's state lets
  change, in any circuit: a row in a state that holds it is no longer
  opened for typing, then refused by the server; it says "Row locked" at
  once, and keeps its place. Until now only compliance's locked and signed
  rows were held back on the screens.
- A seal is said in its own word: a row "changed outside AnyGridDB since it
  was sealed", whatever its state is called; the notification and its mail
  say "a sealed row".

### Added

- **A client's table takes a circuit of its own** (ADR 0137, migration
  0147): its states, its steps, what each step asks, as on AnyGridDB's own
  tables. What a state forbids, a change, some fields, a delete, is
  refused through AnyGridDB; a sealed state seals the row, and a change
  made elsewhere is found and told. A table without a key still has no
  states, and its editor says why. Compliance stays the circuit a client's
  table starts with.
- **Storage has quotas** (migration 0146, ADR 0136): what a base's files and
  an account's may hold, set in MiB in Administration › Limits and usage,
  none by default. A file past one is refused, saying which, in a cell and
  in a form alike, where it was said to be too large. A file no cell
  names any more is released: it counts no more at once, and is deleted
  once the trash would no longer bring its row back; the list of bases
  gives each base's size of what it holds.
- Administration › Limits and usage lists every limit the instance keeps,
  in three more parts (signing in, codes and links; what a cell, a formula
  and a view hold; channels, directories and calls out), each with who sets
  it: how long a link, a code or a challenge lasts is the exchange's own
  and never changes. Every value is the one the instance kept before.
- `anygriddb_undeclared_permission_total` counts the checks that asked a
  permission their way in does not declare. It should stay at 0: report one
  that does not.

## 0.10.2 - 2026-11-26

Nothing to do before upgrading: migration 0145 adds a field type.

### Added

- A field of the **row's state** in its table's circuit: added like a created
  time, it shows each row's state in the circuit's words, and filters,
  sorts and groups by it, in the circuit's order (migration 0145). A state
  still changes by a step only. The API and exports give the state's key.
- A kanban stacks by a row's state: its columns are the circuit's states,
  and a card carried to another takes the step between them, asking what
  the step asks (a reason, a signature); when no step leads there, it says
  so and the card stays.

## 0.10.1 - 2026-11-26

Nothing to do before upgrading: migrations 0143 and 0144 add two
unlogged tables of counts, and every limit keeps its value of 0.10.0
until an administrator sets it. An instance that sets `IMPORT_MAX_ROWS`
or `EXPORT_MAX_ROWS` keeps them: the variables still win.

### Added

- Administration › Instance › **Limits and usage**: every limit the instance
  keeps, where it is set, and what is used of it where it is counted (the
  most one address sent, how many were refused, the most jobs one account
  holds); counts only, never an address or an account. The requests a
  minute, per address, are set there, each within its bounds. How long the
  trash, restore points and the sign-in trail are kept is listed there too,
  and still set in Settings and Security.
- The rows one file may bring in, and one export may write out, are set in
  **Limits and usage** too, between 100,000 and 10,000,000. An instance
  that sets `IMPORT_MAX_ROWS` or `EXPORT_MAX_ROWS` keeps them: the variable
  wins, and the page shows its value with no field to change it.
- **Limits and usage** sets the jobs one person may have queued or running
  (1 to 50, 5 by default), how long finished jobs stay listed (1 to 90
  days, 7) and an export file can be downloaded (1 to 168 hours, 24), the
  live connections one account may hold (4 to 256, 64), and how fast one
  automation runs (30 to 3,000 runs a minute, 300) and how long a run may
  wait for its turn (1 hour to 7 days, a day).
- An account's live connections are counted across every process of the
  instance (migration 0144, an unlogged table), as requests are: one
  served by several processes holds the same number as one served by a
  single process. "Limits and usage" shows the most one account holds.

### Changed

- Rate limits hold across processes: requests are counted in PostgreSQL, a
  minute at a time, so an instance served by several processes refuses at
  the same number as one served by a single process (migration 0143, an
  unlogged table). The probes (`/health`, `/ready`) are not counted, and a
  count the database does not give within two seconds lets the request
  through, said in the log once a minute.

### Fixed

- A base could lose its last owner through a group: a member taken out of a
  group that owned it, the group's role changed or taken back, or the group
  deleted. Each is now refused when it would leave a base that had an owner
  with none, as a change to a person's own role already was.

### Security

- A daily or weekly digest listed what waited for a person even when they
  no longer read its table: a notice queued before their role was taken
  away, or before the table or its base went to the trash, was mailed up
  to a week later with the table's name and what happened. A digest now
  asks again, when it is sent, whether the person reads each table it
  names, and drops what they no longer do.

## 0.10.0 - 2026-11-25

**Roles an administrator made: check them after the upgrade.** A token
(an API token, MCP, an application given access) now reaches a base or a
table only through a role that gives **Reach by a token**, and every way
rows leave a base asks **Export**. Each of the four shipped roles gives
both, so nobody holding one of them loses anything. A role made in
Administration gives them only when they are ticked: in Administration ›
People › Roles, tick **Reach by a token** for each made role whose holders
use tokens or applications. A made role that gives access gives one of the
four only while it holds all that role gives, so it needs **Reach by a
token** too before it can give a viewer, a commenter or an editor.
Migration 0140; nothing to do before.

**Made roles that took circuit steps:** a step now asks **Take a circuit's
steps**, which an editor's and an owner's roles give. A made role that
wrote rows or locked them takes no step after the upgrade until it is
ticked in Administration › People › Roles. Migration 0141.

### Added

- "May validate" without editing or locking: a circuit's step can name a
  made role, and a role of reading and taking steps then takes it (ADR 0130).
- A table's status circuit is edited from the table's menu (**Status
  circuit**), by whoever manages its structure: its states, its steps, what
  each step asks and who takes it, starting from the circuit in place or a
  shipped one; rows of a state that goes are moved where the editor says.
  It replaces the template picker of the base's settings (migration 0142).
- A step through the REST API (`POST …/records/:id/transition`) and MCP
  (`transition_record`); the API's document names each table's states and
  steps. A step that asks a signature is taken in the application.
- An automation can start when a row takes a step, any or the one named; a
  webhook's payload says the states a step moved between, and its key.
- A step signed with `step_up` takes a code of the signer's authenticator as
  well as their password.

### Fixed

- A step that required fields was always refused: they were read from
  values nothing sent, not from the row.
- A signed step that also asked a reason opened the signature without the
  reason, and was refused; the dialog now asks both.
- A table of a client's database could be given a circuit whose states its
  statuses cannot hold: it keeps the compliance circuit.
- A refused step says why: a second person is needed (four eyes), the
  signature's meaning is missing, or a token cannot sign.
- A duration opened to be edited shows its seconds too: an edit started
  from the hours and minutes alone, and a change wrote the seconds away.
- On a phone, a form asks a web address and a phone number with the
  keyboard for each, as the grid does (a phone number there too), and a
  duration, typed as hours and minutes, with a keyboard that has a colon.

### Security

- A role without Export could still take rows out: its tokens read every
  row it read, and it could make a view's or a base's public link, a
  webhook, an automation that mails, calls, posts, runs a script or copies
  rows into another table, a copy of a table or a base with its rows, or
  read a restore point back as a new base. Each now asks Export, and a
  table is copied with its rows only by someone no field or row rule binds
  on it (`docs/operations.md`, "What takes rows out of a base").
- A link, a webhook, an automation or a calendar feed acts by its maker's
  roles as they are when it runs, and does nothing while its maker no
  longer holds what making it asked, or their account is disabled: it
  stays, and works again once they do. Before, a link kept showing rows,
  and a webhook kept sending them, after their maker lost the right to
  make them.

### Changed

- Operator documentation is a runbook again: the historical migration plan is
  gone, and README, operations, sources, and MCP assume Docker and TLS are
  known.

## 0.9.3 - 2026-11-25

**Upgrade with this release's Compose files and its pin, as usual. No
migration; nothing to do before or after.**

### Fixed

- A map with no basemap (no tile server named, the default) drew its rows
  on the whole globe, so the places of one region stood as one blot: it
  now frames them, and moves and zooms as a map with a basemap does.
- What the server refuses is said in the dialog that asked, above its
  buttons, rather than in a toast that could lie over Save on a laptop's
  screen: the automation editor and list, an import, a new base, a file of
  people, a source's settings and its connection test, a dashboard's
  widget, a row's signature asked again after a wrong password, and every
  prompt and confirmation, an account's erasure included.

## 0.9.2 - 2026-11-25

**Upgrade with this release's Compose files and its pin, as usual. One
migration runs as the instance starts (`0139_deliveries`): it moves the
deliveries of webhooks and of notification channels into one journal,
with their history; nothing to do before or after.**

### Changed

- **Every delivery that gave up is in one list.** Administration,
  Instance, Support lists a notification channel's failed deliveries
  beside a webhook's, filtered by what sent them, and sends one again from
  its first attempt. The pending deliveries on the health page, the
  failures on the first page of Administration, and the alert on failures
  count both.
- A notification channel's delivery keeps the fields it sends only until
  it is delivered, as a webhook's already did; both are tried again on the
  same schedule, and a delivery whose attempt a stopped worker lost is
  queued again, a channel's included.
- The API page shows a number field's example as decimal text ("42.5"),
  the form the API's document asks for.

### Fixed

- Two share links of one view or one base, made the same day, read alike
  in the list of existing links: each now says the moment it was made, and
  a view's link says when it allows copying the data.
- A row's history wrote a field's name with a space before its colon in
  English ("Status : … → Done").

## 0.9.1 - 2026-11-25

**Upgrade with this release's Compose files and its pin, as usual. One
migration runs as the instance starts (`0138_made_roles`); nothing to do
before or after. Nobody's access changes on upgrade: the four roles give
exactly what they gave.**

### Added

- **Roles you make.** Administration, People, Roles: make a role of the
  permissions of a base (read, comment, edit, delete, lock and sign rows,
  export, import, publish, shared views, dashboards, tables and fields,
  automations, webhooks, members, the base itself) and give it wherever
  the four roles are given: to a person on a base or a table, to a group,
  by invitation. A change to a role is everyone's at once; a role somebody
  holds cannot be deleted. Whoever may give access gives only roles that
  give no more than their own.
- A base's backup carries a made role by its name and permissions; the
  import gives it back where a role of that name gives exactly those, and
  leaves out whoever's role finds none, so that nobody sees more of the
  copy.

## 0.9.0 - 2026-11-25

**Upgrade with this release's Compose files and its pin, as usual. One
migration runs as the instance starts; nothing to do before or after. Read
two changes first:** support no longer acts on an account that holds a role
of Administration (an administrator does that now), and a notification
channel whose address answers a message with a 301, 302 or 303 now shows a
failure: those messages were never delivered. Point such a channel at the
address that takes them.

### Security

- **Support acts only on accounts that hold no role of Administration.**
  It could clear an administrator's second factors and, on an instance
  without mail, take the reset link of the administrator's account: the
  helpdesk could become an administrator. The same held for another
  support account and for an auditor. Support's "sign everyone out" now
  leaves those accounts signed in; an administrator's reach is unchanged.

### Added

- **Two parts of Administration an administrator gives apart.** An
  account manager adds people, changes their name and address, disables
  them, helps them sign in again, and manages the groups and who is in
  them. A source manager connects client databases and brings their
  tables into the bases it owns. Each opens only its part: neither gives
  a role of Administration or a role on a base, deletes an account, acts
  as someone, or changes a setting, and an account manager acts only on
  accounts that hold no role of Administration. Given and taken away on
  an account's page, with the proof, on the sign-in trail.

### Changed

- **Every call that leaves the instance over HTTPS is held to one set of
  rules:** webhooks, automations' calls and scripts, notification channels,
  the sign-in trail's collectors and traces. Webhooks and automations now
  also refuse a cloud's metadata names, as channels did. A script's call
  follows one redirect on the same address, as a channel's does.
- **A notification channel that answers a POST with a 301, 302 or 303 has
  failed**, and its delivery says so: it was sent again as a GET before,
  which delivered nothing and was counted as sent. A 307 or 308 on the same
  address is followed with the message.

## 0.8.0 - 2026-11-24

**Upgrade with this release's Compose files and its pin, as usual. Two
migrations run as the instance starts; nothing to do before or after. More
mail may leave through your relay:** accounts made from now on, and those
that had email on, get the notices about their work by email at once, and a
base's owners are told by email when a role is given on it. To keep the old
quiet for new accounts, set the instance's defaults in Administration,
Health, "Person notification defaults", before people sign up.

### Added

- **A table can follow another validation circuit than draft, submitted,
  locked, signed.** In a base's settings, each table takes one of three
  shipped templates: compliance (as before, and every table's default),
  simple review (in review, approved) and dual approval (two approvals by
  different people). The row's panel offers the moves the circuit allows to
  the reader's role. A template is refused while a row is in a state it
  does not have, and always while a row is sealed in one. The database
  holds these rules, as it held the four statuses: the application's own
  account may read a circuit, never change it.
- **Every notice mail carries a link that stops that kind of notice by
  email, and every digest one that stops the digest,** with no sign-in
  needed. The link is signed by the instance's keys.

### Changed

- **Each person chooses how each kind of notice reaches them.** The one
  "email me" switch becomes a choice per kind of notice (a mention, a reply,
  an assignment, an automation, a changed role, …): in the app, by email at
  once, in a daily or a weekly digest. An administrator sets the defaults
  for the instance; a person can also silence a noisy base or table. Notices
  about the account's safety and an administrator's emergency access always
  come by email and cannot be turned off. Accounts that had email off (the
  default until now) keep those notices in the app only; accounts that had
  it on, and accounts made from now on, also get them by email, until the
  person or an administrator changes it.
- **Owners of a base are told by email, too, when a role on it is given or
  an owner is named**, unless they turn that kind of notice off.

### Fixed

- **Tasks no longer offers to download an export its author may no longer
  read.** The file itself was already refused once the author's rights had
  changed; the menu still offered it.
- **A refused share link is said in the share dialog,** above Create a link,
  instead of in a message that covered the button.

## 0.7.5 - 2026-11-24

**Upgrade with this release's Compose files and its pin, as usual. No
migration. With files in an object store (`compose.s3.yml`), this is the
first 0.7 version that starts.** A stack that tried 0.7.0 to 0.7.4 that way and stayed
stopped needs one step after the upgrade: `docker compose restart db`, then
`docker compose up -d`, with the same Compose files as `up`.

### Fixed

- **An instance with its files in an object store starts again.** From 0.7.0
  the overlay `compose.s3.yml` replaced the certificates step's arguments
  without the one that makes the application's database role, so `prepare`
  stopped on `role "anygriddb_app" does not exist` and the instance never
  started.
- **Two texts in English that were written as French writes them.** The
  earlier values shown beside a setting (a base's, a table's, a view's, a
  field's, a widget's, a webhook's, an automation's) put a space before the
  colon after the setting's name, and the API page gave "Texte" as the
  example of a text field. Both now follow the reader's language.
- **The automation editor says what an automation still needs, where it is
  given.** Saved with a part missing, an email without recipient or subject,
  a call, a Slack or a Teams message without its address or its text, a
  notification to nobody, or a secret whose name or host the server refuses
  came back as a passing "Invalid input" that named nothing; an update that
  filled no field was kept, and did nothing. Each part now says why under its
  control, nested actions and secrets included, the first takes the
  keyboard, and nothing is sent. Save no longer stays greyed out, unexplained,
  until the automation has a name, and a script on an instance that runs none
  says to choose another action.
- **An address that is no address is refused as one.** A call saved with
  `https://` alone ended in an internal error: it is now refused as an
  address the instance will not call, as a private one is.
- **A read whose page was left is no longer logged as the instance busy.**
  Moving from one view to another before a read ended logged an error
  saying `reads_busy`, the code that tells an operator to give the
  container more memory. It is now `request_closed` (499), at the `info`
  level; a read refused for the memory the process holds still answers
  `reads_busy`.

## 0.7.4 - 2026-11-24

**Upgrade with this release's Compose files and its pin, as usual: nothing else
to do.** No migration. Going back to 0.7.3 afterwards, a restore point that
0.7.4 made of a base with comments can no longer be read: make again the
points you need.

### Added

- **A restore point, a copy of a base, and a copy of a table with its rows
  keep their rows' comments,** with their replies, authors, dates, edits and
  resolutions (ADR 0122). A comment by an account erased since comes back as
  the erased account's. A restore point made before this version has none to
  give back, and a version before this one cannot read a restore point of a
  base with comments. A file downloaded or brought from elsewhere still
  carries no comments: their authors are believed only in the instance's own
  copies.

### Fixed

- **The dialog that adds a field says what it still needs, where it is
  given.** A list without options, a lookup or a rollup without its link or
  the field it reads, and a button that opens no address were sent, and
  the server's refusal came back as "Invalid field" or "Invalid input",
  naming nothing. The dialog now says each one under its control, which
  takes the keyboard, and sends nothing. On a phone, where a table's grid
  draws no header, a field is added from the view's Fields list.
- **A form says what is wrong beside each field, and takes the keyboard
  there.** Sent with answers missing or refused, a public form, the form
  view and the dialog of a new row showed one message at a time, at the foot
  of the form or in a passing notice, and a required date let the browser
  stop the form without a word. Each field to correct now says why under
  itself, is marked for assistive technology, and the first one takes the
  keyboard; the foot of the form says how many there are.

## 0.7.3 - 2026-11-24

**Upgrade with this release's Compose files and its pin, as usual: nothing else
to do.** No migration.

### Added

- **A timeline's bars move under the pointer.** Dragged by its middle, a bar
  moves both its dates; by an edge, that date alone, never past the other.
  The days show while it is carried, a date that keeps a time keeps it, and
  the change is undone like any other. A press that does not move still
  opens the row; from the keyboard, a row's dates are changed in its panel.
  A bar moves only when its dates are fields the row holds.

### Fixed

- **`anygriddb trail verify` reads a collector's file of any length.** It
  read the whole file into memory first: 1.2 million events took 2.2 GiB,
  and a file of more than about 2 million (512 MiB of text) stopped with
  an error. It now reads a line at a time and keeps 24 bytes an event: 6
  million events were checked in about a minute in under 1 GiB, as written or
  in reverse order. A line too long to be a batch, or a batch whose events
  are not events, is counted as unreadable, and a forged batch number no
  longer makes it list every number in between.
- Administration counts the change trail's events still to send up to
  100,000, then says "more than": it counted the whole trail on each
  refresh (0.2 s for 6 million events, 9 ms now).

## 0.7.2 - 2026-11-24

**Upgrade with this release's Compose files and its pin, as usual: nothing else
to do.** A copy of the change trail turned on with 0.7.1 sends the whole trail
again, in the same chain: the collector may receive an event twice. The copy's
indexes are built by the upgrade on a trail of up to 100,000 events; a longer
one gets them beside the writes, under Compose with `docker compose run --rm
indexes`, needed only to use the copy.

### Security

- **An event's place in the change trail is the database's to give.** The
  application's database role could insert an event with a write order of
  its choosing, or none, and such an event would never have reached the
  collectors. Its order and transaction are now taken by the database (ADR
  0121).

### Changed

- **The copy of the change trail sends the whole trail**, oldest first, and no
  longer starts at the newest event when it is turned on. The events written
  before 0.6.1, which have no write order, go first, by date. A copy turned
  on with 0.7.1 sends everything again in the same chain: a collector may get
  an event twice. `anygriddb trail verify` checks them too. A long trail first
  needs the indexes the copy reads: `docker compose run --rm indexes` under
  Compose.

## 0.7.1 - 2026-11-24

**Upgrade with this release's Compose files and its pin, as usual: nothing else
to do.** The change trail's new index is built by the upgrade on a trail of up
to 100,000 events. A longer trail gets it beside the writes: at the start when
the application owns its tables, and under Compose with `docker compose run
--rm indexes`, needed only to turn the copy below on.

### Added

- A copy of the change trail out of the database's reach (ADR 0120). Turned
  on in Administration, Security, Change trail, each change leaves for the
  instance's collectors as a fingerprint: its id, time, action and authors,
  and a keyed digest of what it holds, never a value, in numbered and
  chained batches. `anygriddb trail verify < <file>` compares what a
  collector kept with the database and names what was rewritten there. Off
  by default: size the collector first. A long trail first needs its index:
  `docker compose run --rm indexes` under Compose.

## 0.7.0 - 2026-11-24

**Upgrade with this release's Compose files and its pin, as usual: nothing else
to do.** The stack makes the application's database role, its password and its
rights when it starts. On a PostgreSQL of your own, or with a `compose.yml` of
your own, the instance keeps signing in as the owner of its tables and says so
in Administration > Health. The operations guide gives the two steps that move
it.

### Breaking

- **The application's `DATABASE_URL` no longer names the owner of the tables.**
  A script of yours that reused it for a migration or a change of structure
  needs `POSTGRES_USER` and `POSTGRES_PASSWORD` instead.
- **A refused upgrade or a failed migration is in `docker compose logs prepare`**,
  no longer in the log of `app`, which does not start.
- **A field a locked or signed row holds a value in stays in the trash** until
  that row is unlocked, which the trail records. Purging it would have left a
  record shown as signed without what was signed.

### Security

- **The application no longer signs in as the owner of its tables.** Under
  Compose, a one-shot service, `prepare`, holds the owner's credentials, runs
  the migrations and gives the application a role of its own, `anygriddb_app`,
  with a password made once. That role cannot rewrite the change trail, the
  signatures or the sign-in trail, or change or remove a value a locked or
  signed row holds. What it can still do is written on the trail: unlock a row,
  drop a table, erase an account, purge events past the retention. It could
  also add an event or a signature in someone's name, since the application
  says who acts.
- **The retention purge and an account's erasure write their own event**, in
  the database, whatever called them. The purge takes nothing the instance's
  retention keeps.
- **The change trail answers to the role that owns it.** A setting any database
  session could write was enough to delete an event, give it to another author,
  or change the catalog with no event. It now counts only for the owner of the
  trail. The purge and an account's erasure are functions of that owner, with
  their own limits: nothing younger than a year goes, and an author leaves the
  trail only with the account's deletion.
- **A restore** refuses a free space, a size or a time limit that is not a
  number, where such a value skipped the check for room.

### Added

- **`anygriddb database prepare`** runs the migrations with the address of the
  role that owns the tables, and gives another role what the application needs
  and no table of its own. **`anygriddb database indexes`** builds the indexes
  file fields lack. An application signed in as such a role changes nothing in
  the database's structure at its start, and refuses a database that has not
  been brought to its version.
- **`docker compose run --rm indexes`** builds the index of a file field that
  has none, beside the writes. The application names one that is missing in its
  start log, and files are served correctly meanwhile.

## 0.6.1 - 2026-11-23

**Nothing to do before upgrading.** The upgrade adds one column to the change
trail, without rewriting it.

### Security

- **A long value built to slow a check.** The grants a MySQL server lists, the
  type names a client database declares, and a few other texts were read by
  patterns that took seconds on a long enough value, and held the server
  meanwhile. Each is now read in one pass.
- **The image's build** installs its package manager without running install
  scripts.

### Added

- **The grid from the keyboard.** A field's menu moves the field left or right
  and sets its width in figures, from 60 to 1200 pixels. Alt Down opens that
  menu from a cell. The cell's menu, on Shift F10, continues a series over the
  rows typed, up to a thousand at a time. The shortcuts' help lists them, with
  the keys it did not mention.

### Changed

- **Labels.** A timeline's scales are named by the span they show: Month,
  Quarter and Year, where they said Day, Week and Month. The sign-up page's
  button says "Create an account", as its title does: a script that finds the
  button by its old name needs the new one.

### Fixed

- **A row's history.** Two writes to one row that overlapped could leave an
  earlier change at the top of its history. Each change now keeps the order it
  was written in. Changes kept before this version stay behind the new ones,
  by their date.
- **Dialogs and the keyboard.** A dialog whose text overflows scrolls from the
  keyboard, the shortcuts' help on a phone included. A search of the command
  palette that finds nothing says so to a screen reader, and leaves no empty
  list.
- **The page's security policy.** Loading a page no longer sets off a violation
  of its own policy: a collector of those reports stops receiving that one.

## 0.6.0 - 2026-11-23

**Before upgrading, check what applies to you:**

- **A MySQL source on 8.0.14 or 8.0.15** is refused when it is saved or
  checked: the list of its tables reads a view those versions do not have.
  Move the server to 8.0.16 or later.
- **A PostgreSQL of your own reached with `sslmode=verify-ca` and
  `uselibpqcompat=true`** is refused at the start. Read that way, the mode
  checks the certificate's authority and not the name it was signed for. Use
  `sslmode=verify-full`.
- **Formulas:** a formula at the end of a chain of more than fifteen formulas,
  or whose unit is `ms` or a single letter with an `s`, is refused when saved;
  one already saved shows an error where it showed a blank, or computed with
  months. `IS_BEFORE` and `IS_AFTER` are blank on values that name no date,
  where they compared texts. `POWER` is blank past 65,000 digits. A rollup
  that counts values counts a zero and an unticked box. A group or a sort no
  longer tells an empty text or an emptied list from a cell never filled, and
  a formula in error reads blank whatever else it wrote.
- **Scripts that call the application's own procedures:** `catalog.grant`
  changes the role of a member of the base only. Any other address, with an
  account or without, is refused (`not_a_member`) and is invited instead
  (`catalog.invite`). A base or a table that is not there answers 403
  `access_denied`, as one the caller has no role on, where it answered 404.
- **REST API:** `limit` and `offset` are read in digits only: `limit=0x10` and
  `limit=1e3` answer 400. A path or a query that cannot be read answers 400
  with its code, where it answered 500. An update with no field of a row that
  is not there is refused, where it said the row was updated. A body that is
  no upload answers 415 on the upload routes, where they answered 413 or 406.
- **Monitoring:** a path under a prefix of the API that no route answers is a
  404, and no longer the application's page: a probe set by mistake on
  `/healthz/x` or `/readyz/x` now fails, as it should have. A read stopped by
  its time limit answers 503 `read_timeout`, where it answered 500, and every
  503 says when to ask again (`Retry-After`).

### Security

- **An answer no longer tells whether an address has an account.** Giving a
  role by address took effect at once for an address that has one, and said
  "unknown account" for one that has none. An address with no account now
  locks after the instance's count of failed sign-ins, as an account does.
- **Nor whether an id names anything, to someone with no role on it:** a base
  or a table that is not there answers as one that is.
- **A webhook automation's secret address** answers the same 404 whatever the
  body: one too large, or that was no JSON, answered 413 or 400 before the
  secret was read.
- **An address the server cannot read** (a stray percent sign) gets the
  security headers of every other answer, and no longer names the framework's
  own code nor sends the path back.
- **A forged passkey answer** (its origin, its challenge, or its relying
  party) is refused 401. It was refused as a fault of the server.

### Added

- **Calendar:** a day counts every row it does not draw, those the calendar's
  page of a thousand did not read included, and its count opens the rows of
  that day. The calendar says when its page does not hold them all.
- **The REST API's document** describes the routes that list the bases, a
  base's tables, and the document itself, a list's `timeZone`, a record's
  `fieldKey`, and the `X-Reason` a write gives. A list's parameters are
  written from the schema the list is read with.
- **MCP:** arguments a tool's schema does not take answer the short JSON with
  a code (`invalid_input`) that a tool's other refusals have.

### Changed

- **What someone else changes reaches the open screens:** a shared view made,
  renamed, ordered or removed; a member taken out of a base, who reads at once
  that it is not shared with them; a dashboard's figure after its field is
  removed.
- **A read that failed says so,** with a way to try again, where it was drawn
  as nothing: Administration's first page said that nothing needed attention,
  a public link or an invitation that it did not exist, a base's dashboards
  and its earlier changes that there were none.
- **A base's file is counted as an upload,** 120 a minute per address, with
  attachments and imports.
- **The trash of a table** lists the last delete of each row, and the comments
  of a row are its latest five hundred.
- **The guides** say how to run their commands on an install of the published
  image and what an install needs, and name every series of `/metrics`. The
  limits and the sizes they give are read against the code by a test.

### Fixed

- **A client's columns read exactly:** SQL Server's money and floats, a
  PostgreSQL `real`, a MySQL `TIME` from 32 hours on, binaries. A rowversion,
  or a text holding a nul byte, can be sealed. A seal carries the format of
  the reading that made it: an upgrade raises no alert for a row nobody
  changed, and seals it again in the current format, with an entry in its
  trail.
- **A formula the server takes is one it runs.** One whose argument was bound
  and never read (`YEAR(1)`) cost its table every read, its export, and its
  rows through the API. One row out of reach no longer fails the page.
- **Dates in formulas** compare and order as dates: `IS_BEFORE` and `IS_AFTER`
  compared texts by their letters, and `MIN` and `MAX` were blank on dates.
- **A lookup of a lookup and a rollup of a rollup** read their value. They
  were taken when saved, then read empty or zero.
- **SQL Server:** `JSON_EXTRACT` reads a value past 4,000 characters, which it
  read as blank.
- **Oracle:** a row whose formula joins texts past what a text holds there no
  longer loses the page: the join is blank on that row, and its cell says that
  the text is too long. A check typed in lower case makes its single select.
- **REST API and procedures:** the accounts sort by last sign-in; the tables of
  a source that is not there answer "unknown source" every time; an update of
  a base or a table that changes nothing no longer fails; a method no
  procedure answers (`TRACE`) is refused 405; a reason that does not decode
  (`X-Reason` with a bare percent sign) is kept as sent.
- **Screens:** a list says its ceiling of five thousand rows in a table with
  no link to nest by; with no network, a link to a page not yet loaded leaves
  the application in place, and the page comes back with the network; the
  dialog of a new row no longer offers a link it then refused the row for.
- **Trash:** a row deleted and put back many times no longer hides the other
  rows of the trash, nor makes a restore of several rows fail.
- **Scripts:** the usage written at the head of the backup, restore and
  PostgreSQL upgrade scripts is the usage that works.

## 0.5.0 - 2026-11-23

**Before upgrading, check what applies to you:**

- **PostgreSQL older than 16** is refused before the first migration, with both
  versions named. Upgrade PostgreSQL first.
- **Settings the instance cannot honor stop the start,** and nothing is
  written: a numeric setting that is not a whole number within its bounds (an
  attachment limit above 500 MiB included), an OIDC issuer over plain HTTP
  beyond this machine, and a key that does not open the TLS authority in use.
  Put back the key that sealed it, or add it to
  `AUTH_ENCRYPTION_PREVIOUS_KEYS`. Only if it is lost for good,
  `anygriddb tls reset --yes` sets the certificates aside, and the next start
  issues new authorities for every workstation to install. A new cluster
  refuses `postgres` as the application's role.
- **MySQL and MariaDB sources:** the certificate must name the host the source
  was declared with. A source on MySQL's auto-generated certificate, behind a
  tunnel, or under an alias is refused with `source_tls_failed` until its
  certificate names that host.
- **Single sign-on:** an administrator who signs in through a provider and has
  no second factor here must enrol one. A sign-on finds its account by the
  provider's subject, an ID token must be signed by a key the provider
  publishes, and a SAML assertion must be addressed to this service. Review
  the SAML bindings made before 0.4.0.
- **API tokens no longer create public links,** for a view or a base: a script
  that did is refused, and must create them from a signed-in session. A token
  still lists and revokes links. A link a token made before stays active until
  it is revoked.
- **Values written from outside** (a paste, a file, a form, an automation, the
  API's typecast) are read by the language and format declared, or refused and
  counted, where they used to be made to fit. A number whose comma could be a
  decimal or a thousands separator is refused, and the import preview asks
  what the file uses. A JSON integer past 2^53 is refused: send it as a
  string. A text past its field's limit and a rating that is not whole are
  refused. Values already stored are not rewritten.
- **Imported files:** a JSON file that is not UTF-8, a UTF-16 file, and a file
  mixing two encodings are refused instead of being imported with replaced
  characters. A carriage return alone, outside quotes, now ends a line.
- **Changing a field's type:** a value that does not fit the new type becomes
  empty, where it used to be kept or become false; the preview counts them
  first. A conversion between a date and a date and time needs a time zone.
  Past 20,000 rows it runs in the background, and the table is read-only
  meanwhile: a write answers `table_converting`. A write that read a field
  before it changed type answers `field_changed`.
- **Base files:** a file that claims a row's status or dates, or a row number
  or place too high for new rows to follow, is refused. An import reads the
  whole file again before it makes a base, which takes longer on a large one.
- **Going back:** a restore point made by this version is not read by an
  earlier one.

The upgrade replaces the trigger that dates rows and rewrites no table. On an
instance where an import had left row numbers out of range, so that its tables
took no new row, it brings those rows back beside their table's others, in
their order, and logs one warning for each table repaired. No row's content,
status, or trail changes.

A conversion that runs in the background writes one event per row in the
trail, with the source `conversion`: allow for it on a large table.

### Security

- A sign-on is held to its provider: the account is found by the provider's
  subject, and an address is read only for a first binding, which never
  reaches an account another subject holds. The person is told by mail when an
  existing account is bound, and an account with a second factor of its own is
  asked for it first.
- A session remembers the provider that opened it and ends no later than the
  provider said. OIDC back-channel logout ends the sessions a provider names.
- "Single sign-on only" holds wherever a session is made. Turning it on offers
  to end password sessions and the tokens of non-administrators.
- A MySQL or MariaDB source is checked against the host it was declared with,
  at declaration and on every pooled connection.
- Webhooks and notifications refuse one shared list of reserved and private
  addresses, which adds the special-use ranges each was missing.
- A public link no longer outlives the rights of what made it: only a
  signed-in session creates one.
- An import, a restore point, and a copy no longer let a row that was locked
  or signed be written again: a restore point and a copy keep each row's
  status, and a file from outside is not believed on it.

### Changed

- A restore point, a copy of a base, and a copy of a table with its rows keep
  each row's dates, authors, and status. A signed row comes back locked,
  without its signature, and the job says how many did. A point made by an
  earlier version still restores, as drafts.
- An automation past 300 runs a minute now runs the rest late instead of
  dropping them. A run that waited a day is dropped, and its author is told.
  `anygriddb_automation_runs_paced_total` counts runs delayed and dropped.
- A source's list of tables stops at 2,000, says so, and takes a search; a
  table past the cut is exposed, watched, and refreshed by its name.
- The preview of a field's conversion counts the values emptied and those
  written differently, shows examples, and names the views and computed
  fields that stop working.
- An import's preview says when a file is read as Windows-1252, and its
  report lists the lines a repeated key replaced.
- A start names an unreadable secret file by its error code, a test mail says
  why a relay was refused, and a superuser application role is reported in
  the log and in Health.

### Fixed

- Numbers follow the reader's decimal mark: `1,234` is no longer stored as
  1.234 in every language. A figure a float cannot hold is kept exact through
  a formula, a group, a restore from history, and the import of a JSON file.
- A date that reads two ways follows the field's order, then the language;
  otherwise it is refused, and the message names the format.
- Changing a field's type no longer writes values the new field refuses, takes
  a word for false, or cuts a text at a date or at its commas. On a large
  table it no longer ends on the statement limit, and a failure leaves the
  type, the values, and each row's last modified as they were.
- A row in the trash comes back after a conversion with what still fits, and
  says how many values did not.
- A view whose filter no longer fits its field opens with no rows and offers
  to correct it, and its public link keeps refusing rather than show more.
- A watched table of a source no longer stops at a row dated ahead of the
  engine's clock, and a table of 50 columns or more refreshes again.
- A steady flow of rows no longer stops an automation for good: dropped runs
  counted against its limit.
- An import reads lines ended by a carriage return alone, a delimiter between
  quotes, repeated headers, and a workbook formula with no stored value. A
  failed import says how many rows it had already written.
- A CSV export leaves a plain decimal bare, and JSON and workbook exports keep
  line separators, control characters, and microseconds.
- A field named like one of a snapshot line's own keys keeps its value through
  a restore point and a file.
- A private key of the instance's authorities that no key given opens is no
  longer treated as missing and replaced, which cost every workstation its
  trust. Processes that first start together on one volume settle on one
  authority.
- The managed Compose file passes the same variables as the bundled one, a
  replaced operator certificate is served within a minute, and the image no
  longer holds the TypeScript compiler.

## 0.4.2 - 2026-11-22

**Numbers pasted in the English interface may be wrong.** Until this version,
copying a number shown with a thousands separator, such as 1,234, and pasting
it into a number field stored 1.234, a thousand times less, with no message. A
figure shown rounded was also pasted rounded. Nothing distinguishes such a
value from a right one, so AnyGridDB can neither find nor repair them. If people
used the English interface and copied numbers between cells, check the figures
that matter against their source.

This version keeps a copy made inside the grid exact. **A number with a
thousands comma pasted from outside AnyGridDB, or imported, is still read as a
decimal:** 0.5.0 closes that. Until then, enter such numbers without a
separator.

**Before upgrading, check what applies to you:**

- **Locked and signed rows:** on a two-way link, a row can no longer be linked
  to or unlinked from a locked or signed row, and a row such a row links to can
  no longer be deleted. Unlock the row first.
- **Trash:** once a purge has started on an item, that item can no longer be
  restored, even if the purge failed. The next pass finishes it.
- **API clients that send what they saw:** the comparison now follows the
  field's type, so some stale writes that used to pass answer `row_conflict`.
- **Realtime:** an account holds 64 sockets per process, and a socket is closed
  past 1 MiB of unread messages. A client over a limit reconnects and reads
  again. Pages under a row or field rule reload their view when a table changes.

**After upgrading, if rows are in the trash:** links their deletion removed
before this version can be put back with `anygriddb trash recover-links
--dry-run`, then the same command without the flag.

### Security

- A socket now follows the rights its account has at present. A role taken away
  by any path ends what it hears, on every process.
- A reader under a row or field rule is told that a table moved, never which
  row or field.
- Deleting a row no longer changes a locked or signed row that links to it, and
  neither does editing a link from its other side.

### Fixed

- A cell being edited stays on its row when rows are added or removed around
  it. If its row is deleted, nothing is written elsewhere and the text is given
  back.
- A copy inside the grid keeps exact values, and a lone cell holding a quotation
  mark is no longer quoted.
- A date that does not exist, or an hour a clock change skips, is refused in a
  cell and a form instead of being moved to a nearby value.
- A paste or a file drop says how many items it could not place. A cell holds up
  to 20 files everywhere.
- A letter typed on a date or a checkbox no longer changes it, and a double
  click no longer submits a form twice.
- Links come back when a deleted row is restored, with their history. A restore
  says how many it could not put back.
- A restore confirmed during a purge of the same item is no longer lost.
- A link list past 500 can be added to and removed from. A comment needs a row
  that exists and a parent that is not deleted.
- Reading the catalog no longer holds the instance: its cost now follows the
  number of tables instead of its square.

## 0.4.1 - 2026-11-22

**Before upgrading, check what applies to you:**

- **MCP clients:** a request that carries a JSON-RPC batch now answers 400.
  Send one message a request.
- **Files through the API:** a file is served only while a cell of a live row
  holds it. Attach a file before downloading it. One taken out of its cell, or
  whose row is in the trash, answers 404 to everyone until it is put back.
- **Restores:** `scripts/restore.sh` now needs room for a second copy of the
  database and the files while it runs, and says so before changing anything;
  `--in-place` replaces the data directly when the disk cannot hold both. On a
  stack that runs an object store, a backup without that store's files is
  refused unless you pass `--keep-store-files`.
- **Scripts:** the operations scripts read `.env` as Compose does, so a
  variable set in the shell now wins over the file.
- **Long formulas:** a text a formula computes past 100,000 characters now
  reads as an error in its cell.

The first start builds an index for each file field, beside the writes. Until
it is done, people without field or row rules keep their previous access to
files. A failure is logged as `file index failed` and tried again at the next
start.

### Corrections to the notes of 0.4.0

- 0.4.0 said a write outside a row rule "changes nothing". That was not true of
  an import, which could add rows outside its author's rule, or of a creation
  whose link was refused, which left its row behind. Both are closed here.
  **If people with row rules imported files or created linked rows on 0.4.0 or
  earlier, check those tables for rows outside their rule.**
- 0.4.0 said its read limit held "for every way of reading". It did not cover a
  row's history, rows read by id, group keys, calendar feeds, or the escaping a
  response adds. It does now.

### Security

- An import now writes under its author's row rule and refuses a line outside
  it on its number, on AnyGridDB's own tables and on a client's. An import by
  key therefore works under a rule instead of being refused whole.
- A view, a widget, and a field's settings no longer tell someone what they
  say of a field hidden from them. A public link gets only the settings that
  draw its values, without a formula's source or its thresholds.
- API tokens can no longer list the account's tokens, and a token limited to
  some bases or to reading no longer restarts a job that makes a base.
- The file of a finished job follows its reader's present rights. An account's
  export stays with an administrator or the person it is about. A table's
  export stops being served when its author's field or row rules change;
  exporting again gives a current file.
- A file's details are given only for a file of the table read, and a list can
  no longer be converted into a file field.
- A page is recognised past comments, prologues and UTF-16, and a file's
  extension past trailing dots and spaces, where an administrator refuses them.
- The public API answers not found for a base in the trash.

### Fixed

- A restore that cannot finish no longer costs the instance its data. The
  backup is checked to its end and restored beside the data in service; the
  switch happens by renaming, and any failure puts back what was there and
  starts the application again.
- A restore no longer stops on another session or a background vacuum.
- A restore under a key that does not open the backup is refused before
  anything changes, with its own exit code, instead of announcing a success
  that second-factor sign-ins then fail on.
- A list of sums that is empty, unreadable, or leaves a file out is refused
  on every system.
- The backup, restore, upgrade, install, and compose scripts read `.env` as
  Compose does: a value with spaces, quotes, `&`, or parentheses no longer
  stops them, and nothing in the file is ever run. As with `docker compose`
  itself, a variable set in the shell now wins over the file. A backup stopped
  by an unreadable `.env` is reported to the instance as failed.
- `scripts/install.sh` moves quoted and `export` values as Compose reads
  them, never draws a new key for a variable `.env` names, and changes nothing
  when the password would not open the running stack's database.
- One request can no longer end the process through a row's history, a page of
  escaped characters, a long computed text, or a snapshot past its limits.
- A snapshot past 100 tables is refused before anything is written, with a
  message that says so.
- An upload that stops sending is closed after 15 seconds, and one account or
  public form can no longer take every upload slot.
- A spreadsheet's temporary files are removed with its parser, and what a
  stopped process left is purged at the next start.
- A person's limit of five active jobs holds under simultaneous requests.
- A body nested past any real input is refused before it is validated, and
  `reads_busy` answers 503 on the app's API, as it does on REST.
- `REPT` reaches its documented 10,000 characters, and says so past them
  instead of cutting at 1,000 repetitions.
- The MCP endpoint sends its rate limit headers and bounds each call.

## 0.4.0 - 2026-11-22

_Two statements below claimed more than this version did: see the corrections
in the notes of 0.4.1._

**Before upgrading, if you use SAML:** a first sign-in no longer reaches an
existing account by its address. If your identity provider verifies
addresses, turn on **This identity provider verifies addresses** in
Administration, Connections (or set `SAML_TRUST_ADDRESSES=true`). Otherwise
people whose account is not yet bound to a persistent NameID are refused.

### Security

- A person with a row rule could create a row outside it, or move one out of
  it. The rule now holds for what a row becomes: such a write is refused and
  changes nothing, on AnyGridDB's own tables and on a client's.
- Through SAML, someone at the identity provider who gave themselves the
  address of an existing account could sign in as that account. An assertion
  now reaches an existing account only when an administrator has said the
  provider verifies addresses.
- A read-only API token now changes nothing: every change is refused, a
  procedure added later included. Only an export of what it can read stays
  allowed.
- A token limited to some bases no longer reads, downloads, stops, or
  restarts the jobs of the account's other bases, and no token reaches an
  account's data export. It is also kept off the notifications and
  shortcuts, which span every base.
- No API token can see or answer the account's invitations, or make or
  remove a calendar address, which would go on serving rows once the token
  is revoked. **Calendar addresses a token already made keep working:**
  revoke them from the view's calendar settings if a token was exposed.
- A person removed from a base can no longer download an export they made
  there, and a base's snapshot file asks for the right to manage the base
  at the time of the download.
- One request can no longer end the process by reading too much, with or
  without an account. A request now holds at most 64 MiB of rows, and a
  process a quarter of its heap, for every way of reading: the app, public
  links, the REST API and MCP.

### Changed

- A page too large to hold answers `page_too_large` (400): ask for fewer rows
  or fields. When too much is being read at once, a read answers `reads_busy`
  (503) and can be tried again. A request names at most 10 calls to public
  links.

## 0.3.6 - 2026-11-21

**Before upgrading:** nothing to do. This version adds no migration.

### Added

- How to run a local model beside the instance over MCP is in the operator
  guide (`docs/mcp.md`).

### Fixed

- A dashboard widget that failed to load can be read again from its own
  control, and its icons stay clear when the panel is narrow.
- Administration's Sessions page keeps the list already read when a
  refresh fails, says how many sessions are open, and does not call an
  empty page "no session" while the total says otherwise.
- Deleting a comment asks first, and the copy says the comment is replaced
  by "Comment deleted" (it is not removed from the database).
- A refused source is worded for the person who reads it, and names the
  allow-list variable where an administrator can change it.
- A calendar day is chosen from the keyboard with one tab stop; Enter on
  an event opens it instead of making a row.
- A timeline keeps its row names in a pane beside the axis so they stay
  aligned while scrolling.
- A chart line that starts with no value still has a place for its label.

## 0.3.5 - 2026-11-21

**Before upgrading:** nothing to do. This version adds no migration.

### Added

- `anygriddb_database_reachable` says whether AnyGridDB's own database
  answers, and the guide's alert rules use it, with one on `up`.

### Fixed

- `/metrics` keeps answering while the database is down: it failed whole,
  at the moment an operator needs it. The queue's series leave for as long
  as the outage lasts, and the size keeps its last reading.
- An OAuth application's token and revocation calls have a limit of their
  own, 120 a minute per address. A backend renewing its people's grants no
  longer uses up the sign-ins of everyone behind its address.
- A comparison (`>`, `>=`, `<`, `<=`, between) finds a float too large to
  read by the value the client's database stores. On Oracle a NaN passes
  no comparison, and an infinity is the number it is.
- An Oracle formula over a large text no longer stops its table's page. A
  formula that gives a large text offers no sort, group or equality filter.

## 0.3.4 - 2026-11-21

**Before upgrading:** nothing to do. Afterwards, a notification channel
whose address redirects to another host needs its final address, and a
trace collector saved on a private address runs only while private
notification targets are allowed.

### Security

- An administrator acting as someone is held to that person's field and
  row rules on every route, and has none of an administrator's powers
  meanwhile. A job cannot be started while acting. Acting ends when the
  administrator loses that role, and an open socket follows.
- Revoking an OAuth access token ends its grant. A code not yet exchanged
  no longer survives a password change or a revocation of tokens.
- A notification channel's credentials stay with the host they were
  entered for: a redirect to another host is not followed, and moving a
  channel to another host asks for its secret again.
- A trace collector saved in Administration is held to the address checks
  of every notification channel, at each connection.
- A public link no longer names the fields it hides.

### Fixed

- A figure that needs a float too large to read is left empty: it was
  computed without that value, and showed a wrong total. Such a cell is
  no longer counted as empty.
- An Oracle table opens whatever types it holds. ROWID, XML and vectors
  read as text; LONG, BFILE and a type of the client's own say their type
  in the cell. A float too large to read keeps its first character there.
- A chart offers only the fields it can group by.
- A formula can be duplicated on any client table.

### Changed

- When a source's host is outside `ANYGRIDDB_SOURCES_ALLOWED_HOSTS`,
  Administration → Sources says what that leaves (tables that cannot be
  read, tables on their last copy, bases held there) and marks blocked
  hosts, a replica's included. Tables, bases and dashboards that depend
  on them stay visible with a clear note. Emptying the allow list is
  documented the same way in `docs/sources.md`.

## 0.3.3 - 2026-11-21

**Before upgrading:** nothing to do. If you changed your encryption key
on an earlier version and still hold the earlier key in
`AUTH_ENCRYPTION_PREVIOUS_KEYS`, leave it there until this version has
started once, then follow "Changing the encryption key" in
`docs/operations.md` from its step 4.

### Fixed

- A client's table whose engine holds uncommon types is read without
  stopping the page: a float past what a decimal can hold reads empty
  and is said beside the cell; SQL Server geography, hierarchyid, xml
  and the like, and MySQL bit and spatial types, read as text; a sum or
  mean of a whole number on SQL Server is taken as a decimal so it does
  not overflow; an Oracle CLOB is not sorted, grouped or compared by
  equality (patterns and counts still work); a figure past what the
  engine computes leaves that figure empty beside the others.
- "Duplicate field" works on a table of a client's database: the copy
  is one of AnyGridDB's own fields beside the client's rows, and holds
  what the field held. The copy was made empty, and the page read
  "Invalid row id".
- A single sign-on that is refused says why on the sign-in page (a
  disabled account, sign-up closed, maintenance, an address the provider
  did not verify), and a sign-on no longer counts in the limit on
  password attempts: ten people a minute behind one office address could
  sign in before the eleventh read a page of raw JSON.
- A view opened by a public link scrolls from the keyboard: the region
  that holds its rows takes the keyboard, and shows that it has it. A
  view drawn as cards holds nothing to focus, so more rows than the
  window shows were reached with a pointer only.
- A text no database can keep (a NUL, half a surrogate pair) is refused
  on every route, with an answer that says so rather than an internal
  error, and a mail relay's host is checked as a host name.
- The instance's log says "Server listening at https://…" when it
  starts: it wrote `http://` of a port that speaks HTTPS only.
- An export under a search works: whatever the word searched, the job
  failed. A search on a view with no field it can read finds nothing
  instead of failing.
- Email settings a mail relay refuses say why: nothing answers at
  this host and port, the connection cannot be encrypted and verified
  (no STARTTLS, a certificate the instance does not trust, a port that
  speaks no TLS), or the account is refused. Each read "Invalid email
  settings: check the host, port, and password", whichever it was.
- SCIM: a provider that changes only a given name or a family name keeps
  the other part, and reads both back (migration `0120`).
- The functions of a formula, in a field's dialog, are 24 pixels to
  press, as WCAG 2.2 asks: they were sixteen tall, in rows four pixels
  apart.
- A person sees their passkeys in their settings and removes one, as
  for a key that was lost: only an administrator could, and for all of
  the account's factors at once. With no second factor left, the backup
  codes stop working too.
- A webhook's delivery that has not been tried yet reads "Waiting to be
  sent" in its log. It read "Retry scheduled (—)", as a delivery that
  failed and waits for its next attempt does.
- A change of encryption key, as the guide gives it, keeps the instance
  up. The keys of the stack's certificates are sealed again when the
  stack starts with a new key, and `anygriddb keys status` counts them.
  They were left under the earlier key, so that taking it away made a
  new internal authority, which PostgreSQL did not serve until it was
  restarted. The commands no longer run as root.
- The backup, restore and PostgreSQL 18 scripts read a stack's name
  from its composition's own. With a `configs:` section among a stack's
  files they took a config's name for it, and looked for the stack's
  volumes under that name: a backup then held the database and, for the
  files and the authority, archives of nothing, and said it went well.
  A backup also refuses a volume that is not there, which Docker would
  make, empty. An install made by the guide has no such section.
- A request that names an API token answers for that token: one that
  was revoked or has expired is refused, even from a browser that also
  holds a session.
- MCP answers `405` to `GET` and `DELETE`, as a server with no stream and
  no session does. A `GET` held its connection open.
- An application's redirect address may not hold a fragment or an
  account.
- `scripts/backup.sh` tells the instance once of a run, by what became
  of the backup: a run that failed while a file was written was listed
  twice in Administration. A run that fails or is stopped keeps nothing
  of what it had written, where it left a folder with part of a dump;
  and what a run writes is its owner's alone from the first byte.
- On SQL Server, a field held in the old `text`, `ntext` or `image`
  types can be sorted and grouped: the rows could not be read. On
  Oracle, a link field is no longer offered for grouping, which that
  engine cannot do.
- "Duplicate field" is offered only on a table that can take the copy:
  not on a store read from a copy, nor on a table with no primary key.
- The count of rows a client's database estimates is 24 pixels to press.
- A new install's database log holds no error from the first start.
  The instance asked for the job queue's first table before making it,
  and PostgreSQL wrote the refusal at every new install:
  `relation "graphile_worker.migrations" does not exist`.
- A new install waits for its database. PostgreSQL was called healthy
  while its image was still making the cluster, on a server nothing
  reaches over the network, and AnyGridDB was started in front of it: on
  a disk slow to make a cluster it stopped and started again until the
  database was there, and `docker compose up --wait` ended on an error.
  The database is healthy once it answers on the network.
- A new install's database log holds no warning: the cluster is made
  with its access methods said, where `initdb` warned about the ones it
  chose. What PostgreSQL serves does not change.
- A field's menu, in a grid, offers what the field can do: no grouping
  by a files field, and neither a sort nor a grouping by a field that
  AnyGridDB keeps beside the rows of a live client table. Each was
  offered, the server refused it, and the rows could not be read.
- On a live client table, a kanban, a calendar and a timeline are drawn
  by fields the client's database holds, and say what they need when it
  holds none. Drawn by a field kept in AnyGridDB, each read "The rows
  could not be read", with no way to choose another field.
- Frozen columns leave the others room to scroll. "Freeze up to here"
  on a far field kept in place more columns than the window is wide:
  the others, their menus and the column that adds a field lay under
  them, and nothing scrolled them into view. As many frozen columns
  stay as the window has room for; a wider window keeps them all.
- In a grid, a control that takes the keyboard among the columns that
  scroll is brought clear of the frozen ones: it could stand under them.

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
