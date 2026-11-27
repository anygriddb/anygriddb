# 0131 — One table of attributions, by union, and one of delegated accesses

- Status: Accepted
- Date: 2026-11-26
- Supersedes: 0126 (`instance_roles` and the three columns of
  Administration), 0127 and 0128 ("a table's role still replaces the
  base's"; rights at a past date without a made role's permissions), 0129
  (a table's role that keeps a token out of its base's reach)
- Relates to: 0016 (field and row rules), 0038 (SCIM), 0043 and 0094
  (tokens, applications), 0054 (support), 0070 (groups), 0071 (the
  auditor), 0073 (the proof), 0086 (the administration API), 0106 (a
  migration that refuses), 0134 (every way in declares what it asks)

## Context

Access is held in eleven places, each with its own rules:

- **Roles on a base or a table:** `role_bindings`, one of the four or a made
  role; a group's role on a base is a row of `group_roles` _and_ a copy in
  `role_bindings` for each of its members (`syncGroupBindings`). A group
  has no role on a table.
- **A table's role replaces its base's** (`effectiveTableRole`), downward
  as upward: a role given on a table can take access away. Nobody reads
  from the list of what was given what someone holds.
- **Field and row rules:** `table_acls` and `column_acls`, a person's only,
  one row rule per table and person (ROADMAP 9), and binding only who lacks
  `members.manage` there.
- **Administration:** three columns on `users` (`is_admin`, `is_support`,
  `is_auditor`) and `instance_roles` for the two parts given apart.
- **What acts without a session:** `api_tokens` (an application's grant
  makes one), `admin_tokens`, `scim_tokens`, `calendar_feeds` (no end),
  `shares` (no last use), an automation's inbound secret (neither), each
  with its own expiry, revocation and screen; a job a token started runs on
  all its author's roles.

Nothing ends by itself, and several checks compare `role = 'owner'` as
text, where a made role that manages the base does not count.

ADR 0134 made every way in declare the permissions it asks, from the base's
catalogue and Administration's: that is the net this record is built on.

## Decision

### 1. One table of attributions

An attribution gives a role to someone, somewhere, maybe until a date:

| Column                        | What                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- |
| `id`                          | `uuid`, `ag_uuidv7()`                                                     |
| `user_id` / `group_id`        | the subject: exactly one of the two                                       |
| `role` / `made_role_id`       | a shipped role's key, or a made role: exactly one                         |
| `scope`                       | `instance`, `base` or `table`                                             |
| `scope_id`                    | the base or the table; null for the instance                              |
| `row_filter` / `field_access` | optional, on a table only: which rows, and each field hidden, read, write |
| `ends_at`                     | optional; past it the attribution gives nothing                           |
| `given_by`, `created_at`      | who gave it, and when                                                     |

- CHECKs: one subject, one role; `scope_id` null exactly for the
  instance; a made role never at the instance; rules only on a table; an
  instance role is one of the five of §4. A unique index per subject, role
  and scope, so the same thing is never given twice.
- **An invitation is an attribution to come:** `invitations` keeps its
  address, token and fourteen days, and holds the attribution's columns;
  accepting it writes the attribution.
- **Groups are stored once:** a group's attribution is one row, and the
  decision reads the person's groups when it loads (`group_members`).
  `group_roles` and the copies in `role_bindings` go.
- **Gone:** `role_bindings`, `group_roles`, `table_acls`, `column_acls`,
  `instance_roles`, `users.is_admin`, `users.is_support`,
  `users.is_auditor`.
- **Every change of an attribution or of a group's members** is written to
  the change trail by the database, and tells open sockets to ask again by
  a trigger: the list kept by hand (`RIGHTS_CHANGES`) goes.
- **An attribution that ends** gives nothing from `ends_at` on; a nightly
  pass removes it, written to the trail as ended, not as taken away by
  someone.

### 2. The decision: a union, nothing less below than above

- **What someone may do on a table** is the union of the permissions of
  every attribution that reaches them there: at the instance (Administration
  gives no base permission), on its base, on the table, given to them or to
  one of their groups. **Nothing given lower takes away what is given
  higher**: a role on a table only adds.
- **Rows:** a rule narrows only the attribution it comes with. The rows
  someone reaches for an act are those of every attribution that gives the
  act, combined by OR: one without a row filter gives every row. So a
  table's editor limited to their own rows, under a base's viewer, reads
  every row and writes their own.
- **Fields:** an attribution without field access gives every field, to
  write when its role writes rows; with one, each field at the access it
  says, never above what its role gives. Several are combined by the
  widest.
- **A table's attribution and its base:** whoever holds an attribution on a
  table sees its base and, of it, only what reaches that table (the base's
  list of tables, its activity and trash on that table, and the dashboards
  whose every widget reads a table they read).
- **Who manages a table is never narrowed:** a rule on an attribution that
  gives `members.manage` holds nothing, and setting one is refused.
- **A rule needs a role on its table alone:** a role on the base, one's own
  or a group's, gives the table whole. So a person's own role on a base can
  be **given table by table** (the same role on each of its tables, none on
  the base), the conversion's case (d) done by hand; someone with roles on
  some tables only stays in the base's members.
- **One decision** in `packages/core`, read by every check through
  `demand`, `granted` and `holds` (ADR 0134); the one that lets a table's
  role replace its base's goes.
- **Invariants the function holds whatever is given:** nobody gives more
  than they hold (`mayGive`, by permission sets); every base keeps a
  holder of `base.manage`, a group's included (#501's rule, kept on the
  table); the instance keeps an administrator; support and an account
  manager act only on accounts that hold no role of Administration
  (`helpdeskReach`); every change of Administration asks for the proof
  (ADR 0073); a token reaches only what its role lets a token reach
  (`api.access`).

### 3. The conversion, and what cannot be kept exactly

Everyone's access to every **existing** table is kept exactly, but where
said. Each case is counted by the migration's check:

| Case | Today                                                                                                                                                           | After                                                                                                                                                                                      | Exact?                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| (a)  | a table's role that gives at least the base's, or a table role with no base role                                                                                | the same attributions                                                                                                                                                                      | yes                     |
| (b)  | a narrower table role or a binding rule, for someone whose base role manages the base (`base.manage` or `members.manage`)                                       | the base role is kept and the table widens to it                                                                                                                                           | no                      |
| (c)  | a narrower table role, otherwise                                                                                                                                | the base attribution falls to the **floor** (what they hold on the base ∩ on each table where they are narrowed), and an attribution on each table gives back exactly what they held there | yes, on existing tables |
| (d)  | a field or row rule on someone it binds                                                                                                                         | an attribution on each existing table of the base, the ruled ones carrying their rule; the base attribution goes                                                                           | yes, on existing tables |
| (e)  | a narrower personal table role, or a rule, under a base role a **group** gives                                                                                  | the group's attribution is not lowered: the table widens                                                                                                                                   | no                      |
| (f)  | in (c), a permission checked only on the base (`schema.manage` for tables and folders, `data.import` of a workbook, `publish` of a base's link) above the floor | lost at the base: they keep it on each table they held it on                                                                                                                               | no                      |
| (g)  | a field or row rule on someone who holds `members.manage` on the table, where it binds nothing                                                                  | dropped                                                                                                                                                                                    | yes                     |

- **One treatment per person and base**, in this order: _keep_ when they
  manage the base or a group's role there is narrowed ((b), (e): the base's
  roles stay, every narrowed or ruled table widens, its rule dropped);
  _ruled_ when a rule binds them ((d)); _lower_ when a table's role narrows
  ((c)). Someone with roles on tables only is never narrowed: each table's
  attribution takes its rule as it is.
- **The floor** is a permission set: a shipped role or an existing made
  role with exactly that set when there is one, otherwise a made role the
  migration creates ("Floor of «Editor» and «Reader»"), which passes the
  catalogue's CHECK, takes a name nobody uses, and no longer follows the
  roles it came from.
- **Trashed tables count as existing:** a restore after the upgrade gives
  back exactly what was held.
- **What is not kept exactly:** tables made after the upgrade reach a
  person of (c) at the floor and a person of (d) not at all, until someone
  gives them more; and the cases (b), (e) and (f) widen or lose as said.
- **The migration's check** (`.check.sql`, ADR 0106) counts each case by
  instance and refuses while (b) to (f) are not zero, saying how many of
  each and how to read them. It counts with `ag_rights_review()`, the
  function the release before adds (migration 0149): an upgrade from an
  older release that holds a table's role or a rule is refused until that
  release has run, since nothing else would say what it changes. It lets the upgrade through when the operator
  accepts them, by an acceptance this record adds to the migrator: an
  environment variable naming the migration
  (`ANYGRIDDB_ACCEPT_UPGRADE=<number>`), passed to the checks as a session
  setting they read. Nothing is written before.
- **To read them first:** the release before the one that converts adds
  Administration › People › Rights to review, `ag_rights_review()` per
  person, base and table, so an operator sees and may change them (remove a
  narrowing, give a table apart) with the version they run. The count this
  record gives is the query: an instance's own numbers come from its check,
  and none is published.
- **A test runs the old decision and the new one side by side** on
  generated bindings, groups, made roles, rules and tables (trashed ones
  included), and holds every existing table to the same access but in the
  cases counted.

### 4. Administration in the same model

- **Administration's catalogue** is ADR 0134's: the helpdesk, accounts,
  what reaches a whole account, ending sessions, groups, made roles, giving
  access, overseeing access and bases, creating bases, sources and browsing
  them, settings, operating the instance, reading and exporting the trails.
- **Five shipped roles of the instance**, given by an attribution at the
  instance: administrator, support, auditor, account manager, source
  manager, each the pack ADR 0134 holds to `admin-reach.freeze.json`. An
  administrator gives them, with the proof, each change on the sign-in
  trail as now.
- **No role of the instance made by hand**, as ADR 0126 said: a made one
  could give the helpdesk without its reach and climb.
- **The auditor's rule** stays by what a procedure is (a query) and
  **creating bases** stays a policy (everyone, or administrators).
- **Migration:** row for row, nothing lost: each `true` column and each row
  of `instance_roles` becomes an attribution at the instance.

### 5. One notion of delegated access

- **A delegated access** acts without its author's session: an API token
  (an application's grant included), a token of the administration API, a
  SCIM token, a calendar feed, a public link, an automation's inbound
  secret. One table, `delegated_accesses`:

| Column                                  | What                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `id`, `kind`                            | the kind: `api_token`, `application`, `admin_token`, `scim_token`, `feed`, `link`, `inbound_hook` |
| `author_id`                             | whose rights it acts by                                                                           |
| `name`, `secret_hash`                   | its name; the SHA-256 of its secret, never the secret                                             |
| `permissions`, `scope`, `scope_id`      | what it was entrusted: a subset of the author's, where                                            |
| `ends_at`, `last_used_at`, `revoked_at` | until when, last use, revocation                                                                  |
| `details`                               | what its kind adds (a link's view and password, a feed's view, an application's client)           |

- **As built** (migration 0155, the tokens first): a token may reach
  several bases, which one `scope`/`scope_id` cannot say, so the table
  keeps `base_ids` (null: every base its author reaches); an
  application's client is a real foreign key, `client_id`, so that
  deleting a client takes its grants. `permissions` null means all the
  author holds. An application's renewal changes the secret of its one
  access; neither a use nor a renewal is on the change trail. Feeds, links
  and inbound secrets (migration 0156) keep in typed columns what the code
  filters, updates and follows by reference: `view_id`, `base_id` and
  `automation_id`, each with its foreign key, and a link's settings and
  password, each column held to its kinds by a check. A suspension is a
  state Administration › Sharing › Access computes (an author disabled or
  no longer an administrator, a policy that stops it, what it shows in the
  trash), not a column nor a line of the change trail per access: the
  decision reads the author at each use, and the trails already say why
  (an account disabled, a role taken away). An automation's address does
  not end: it lives with its automation.
- **What it may do is what it was entrusted ∩ what its author holds when
  it acts**, a job a token started included, at each run. While the author
  no longer holds it, or is disabled, it is **suspended** (it stays, does
  nothing, and comes back); a suspension is written to the trail.
- **The same rules for all:** an end date for every kind (a feed and a link
  get the instance's longest; an existing one keeps none until it is
  renewed), a last use, a revocation.
- **Apart, and why:** the installation token (single use, made before any
  account exists, by the command line) and OAuth's ten-minute codes (a step
  of the protocol, not an access).
- **One page, Administration › Access:** everything that reaches the
  instance without a session, by kind, author, reach, end, last use and
  state, with revocation; webhooks and automations, which act as their
  authors, beside them. Each kind keeps its page to make one.
- **Migration:** row for row: ids, dates and hashes kept, nothing
  re-issued.

### 6. Reading rows by a token is an export

- Reading rows through a token or an application asks `data.export` besides
  `api.access`: a whole table read a page at a time is an extraction. The
  four shipped roles hold both, so nobody who holds one loses anything. The
  API console in a session stays open.

### 7. Three more shipped roles of a base, and "Duplicate"

| Role        | Permissions                                                                                | For                                       |
| ----------- | ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Reader      | `rows.read`, `rows.comment`                                                                | reading, without taking rows out          |
| Contributor | `rows.read`, `rows.comment`, `rows.write`, `rows.delete`, `rows.transition`, `data.import` | editing, without exporting or publishing  |
| Validator   | `rows.read`, `rows.comment`, `rows.transition`                                             | "may validate", named on a circuit's step |

- The four keep their packs exactly. Shipped roles are never changed nor
  deleted; Administration › Roles offers **Duplicate** on each, which makes
  a made role of the same permissions.
- **Effective rights** show every permission and the attribution it comes
  from (direct, a group, the base, the table, until when), rules included.
- **Rights at a past date** read every attribution and the permissions a
  made role had then, from the change trail.
- A test reads the CHECK on `made_roles.permissions` from the catalog and
  holds it to `PERMISSIONS`.

## What breaks

- **For an operator:** the upgrade refuses while the conversion has cases
  that are not exact, until accepted (§3); the release before shows them.
  `ADMIN_EMAILS` and the recovery command write an attribution.
- **For an API client:** a made role with `api.access` and without
  `data.export` no longer reads rows by a token (§6). A feed's and a link's
  address keep working. The administration API answers its accounts with
  their roles of Administration as attributions.
- **For a person:** in (b), (e) and (f), what the check counted.

## Order of the work

1. The review (`ag_rights_review()`, its page), released alone.
2. The table, the union in core, the conversion and its check; reads,
   writes, groups stored once, rules on an attribution (a group's too:
   ROADMAP 9 closed), end dates, the trigger. The side-by-side test runs the
   real migration on generated roles and rules and holds every existing
   table to the access the old decision gave, but in the cases counted.
3. Administration's attributions.
4. Delegated accesses and their page.
5. Reading by a token asks an export.
6. The three roles, Duplicate, effective rights, rights at a date, the
   catalogue's test.

## Rejected

- **Restricted tables** (this record's first draft): a table that does not
  take its base's roles is a way to give less below than above.
- **Refusals (deny entries):** an access nobody can read from what was
  given.
- **Keeping the base role and the narrowing side by side for a while:** two
  decisions to keep true, the very thing this record removes.
- **Made roles of the instance:** see §4.
- **"Everyone" as a group:** nothing asked for it; a group kept by the
  directory does it.
