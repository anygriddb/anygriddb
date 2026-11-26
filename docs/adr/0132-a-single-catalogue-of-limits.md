# 0132 — A single catalogue of limits

- Status: Accepted
- Date: 2026-11-25
- Amends: 0009 (rate limits leave process memory), 0043 / 0044 (policy
  numbers declared here), 0069 (retention declared here), 0110 (read budget
  declared here), 0115 (automation pace declared here)

## Context

Security policy numbers are bounded and changeable (`POLICY_BOUNDS` in
`packages/core/src/instance.ts`). Every other ceiling lives elsewhere:
`RATE_LIMITS` in `apps/api/src/rate-limit.ts`, jobs per person, sockets per
account, automation runs per minute, import and export row ceilings, display
ceilings for a calendar, a map and a list, retention of jobs and export files,
parse and script sandbox budgets. Defaults disagree with what the docs say
(campaign BUG-API-013). Rate limits are counted in memory per process, so with
several API processes they multiply (ADR 0009 accepted that; it no longer
suits an instance that must tell the truth). Jobs per person are checked
outside the insert (campaign BUG-API-008). Storage quotas by base and by
account are still open (roadmap 38). There is no one place an administrator
reads what is in force and what is being used.

## Decision

### Catalogue

Every limit the product enforces or shows is declared once in
`packages/core`, under a stable identifier. Each entry holds:

| Field         | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `id`          | Stable snake_case name, the only name code and the trail use                                      |
| `unit`        | `requests`, `rows`, `bytes`, `sockets`, `jobs`, `runs`, `days`, `hours`, `minutes`, `channels`, … |
| `default`     | Value shipped                                                                                     |
| `min` / `max` | Bounds any change must keep                                                                       |
| `scope`       | `instance`, `base`, `account`, or `automation` (and, for rate, the client address)                |
| `admin`       | Whether an administrator may change it in Administration                                          |
| `kind`        | `enforce` (a refusal or a wait) or `display` (the screen shows the ceiling and keeps working)     |

Scattered constants (`RATE_LIMITS`, `MAX_ACTIVE_JOBS`, `RUNS_PER_MINUTE`,
`POLICY_BOUNDS`, env `EXPORT_MAX_ROWS` / `IMPORT_MAX_ROWS`, view ceilings, …)
become aliases of these entries, then disappear. The environment may still
bootstrap a value that Administration then owns (ADR 0083): what it set is
shown and cannot be lowered past the operator's floor until the process is
restarted with a new value.

### One check

`assertLimit` (name indicative) is the only gate. It returns or throws
`limit_reached` with a stable detail naming the `id` and the ceiling in
force. Existing codes that already mean a ceiling (`too_many_jobs`,
`page_too_large`, `email_otp_rate_limited`, …) keep working as aliases that
carry the same detail, then fold into `limit_reached` once every caller and
every UI string reads the catalogue id. A display ceiling never throws: the
view keeps the notice it already shows ("the first N of M").

### Counters in PostgreSQL

Anything that must be exact across processes is counted in PostgreSQL (ADR
0009 keeps Redis out). A counter row is moved in the same statement that
decides, as automation pace already does (ADR 0115). On a hot path that
already opens a transaction (a job insert, a run start), the check rides that
transaction: no second round trip. Rate limits and other address-keyed
windows use one upsert per request; that cost is the price of a true count.
Process-local memory stays only for what is a property of the process itself
(the read-budget heap share of ADR 0110, scripts running in this process).

### Administration

A page **Limits and usage** under Instance lists every catalogue entry an
administrator may see: its value, its bounds, whether it can be changed, and
the current consumption where a counter exists (per instance, and drilled to
a base or an account for scoped quotas). A change asks for the proof (ADR 0073) and is written on the trail with the earlier and the new value. Security
policy numbers that already have a home on the Security page keep that home;
they read and write through the catalogue. Display ceilings appear as
read-only rows so the page is the whole picture.

As built (family 2): the requests a minute are the limits set there; the
sign-in trail says who changed the limits, as it says for every setting
(ADR 0043), and the values before and after go to the log beside it.

As built (family 3): the jobs one account may have queued or running, how
long finished jobs are listed and an export file kept, the sockets one
account may hold, and an automation's pace (runs a minute, longest wait)
are set there, within their bounds, and read where they are held: a job's
insert (under its advisory lock), its end and the hourly purge, a socket's
opening, a run's place. The jobs' usage is counted against the value set.
An account's sockets are counted across processes in `live_sockets`
(migration 0144, unlogged): one row a process and an account, renewed
every 30 seconds, not counted once a process has been silent for 90; a
seat is taken under an advisory lock on the account, given back when the
socket closes, and the process's own count still bounds an account when
the database cannot count. The page shows the most one account holds.

As built (family 4): the rows one file brings in and one export writes
out (`import.max_rows`, `export.max_rows`) are set there, within their
bounds, and read when a file or a job starts, through the settings' cache.
`IMPORT_MAX_ROWS` and `EXPORT_MAX_ROWS` fix them instead when set (ADR
0083): the page shows the environment's value with no field, and a change
of a limit the environment fixes is refused (`set_by_environment`); what
was saved for it stays, unused while the variable is set. The entry names
its variable (`fixedBy`).

As built (family 5): the days the trash, restore points and the sign-in
trail are kept are entries of the catalogue, with their bounds, which the
settings' schema reads (`boundsOf`); they stay set in Settings and
Security, and the page lists them. The change trail, kept for ever unless
Security says otherwise, has no ceiling to list.

### Storage quotas (roadmap 38)

`storage.base_bytes` and `storage.account_bytes` enter the catalogue. A base's
files already show their size; the quota is checked when a file is accepted,
with the same `limit_reached` detail. Removing a file from a cell does not
free the quota while the table still holds it (the roadmap's note): the page
says so beside the consumption.

### Told where the person acts

An enforced limit is refused at the action that hit it (a job start, an
upload, a sign-in, a socket open), with the catalogue id so the UI can name
the ceiling. Display ceilings stay on the view, as today.

## Catalogue

Defaults below are the values the tree holds today, or the operator defaults
in `docs/operations.md` where the environment already sets a ceiling. No
`LIMITES.md` was found under the campaign folder; campaign cards that measured
a gap (BUG-API-008, BUG-API-013) are cited where they force the design. Bounds
for new admin-set entries follow the same floors the security policy already
uses: a lower bound that still protects, an upper bound the process can
survive.

### Rate of requests (per client address, per minute)

| id                 | default | min |    max | scope   | admin | why that admin flag                                          |
| ------------------ | ------: | --: | -----: | ------- | ----- | ------------------------------------------------------------ |
| `rate.auth`        |      20 |   5 |    120 | address | yes   | Tight on purpose; floor keeps brute force bounded            |
| `rate.oauth`       |     120 |  30 |  1_200 | address | yes   | An application's backend renews many grants from one address |
| `rate.sign_on`     |     300 |  60 |  3_000 | address | yes   | An office arrives together at the provider                   |
| `rate.share`       |     240 |  60 |  3_000 | address | yes   | Public pages; still bounded                                  |
| `rate.api`         |     600 |  60 |  6_000 | address | yes   | Tokens, SCIM, MCP                                            |
| `rate.upload`      |     120 |  30 |  1_200 | address | yes   | Attachments, imports, snapshot upload (same bucket)          |
| `rate.form_upload` |      30 |   5 |    300 | address | yes   | Public forms, no account                                     |
| `rate.report`      |      30 |   5 |    300 | address | yes   | Client error reports                                         |
| `rate.app`         |   3_000 | 300 | 30_000 | address | yes   | Signed-in app traffic; floor still above a busy desk         |

Build files under `/assets/` stay uncounted (they are content-addressed and
ask nothing a limit protects).

### Jobs, sockets, automation pace

| id                             |   default |    min |       max | scope      | admin | why                                                                                      |
| ------------------------------ | --------: | -----: | --------: | ---------- | ----- | ---------------------------------------------------------------------------------------- |
| `jobs.active_per_account`      |         5 |      1 |        50 | account    | yes   | Protects the queue; floor stops a runaway; the check moves into the insert (BUG-API-008) |
| `jobs.retention_days`          |         7 |      1 |        90 | instance   | yes   | Finished jobs listed this long                                                           |
| `export.file_hours`            |        24 |      1 |       168 | instance   | yes   | How long an export file can be downloaded                                                |
| `sockets.per_account`          |        64 |      4 |       256 | account    | yes   | Live updates; counted across processes                                                   |
| `sockets.channels_per_socket`  |       128 |      8 |       512 | account    | no    | Wire shape of one connection; raising it does not help an operator                       |
| `sockets.queued_messages`      |       256 |     32 |     2_048 | account    | no    | Same                                                                                     |
| `sockets.buffered_bytes`       | 1_048_576 | 65_536 | 8_388_608 | account    | no    | Same                                                                                     |
| `automation.runs_per_minute`   |       300 |     30 |     3_000 | automation | yes   | ADR 0115; floor keeps a loop from taking the workers                                     |
| `automation.max_delay_minutes` |     1_440 |     60 |    10_080 | automation | yes   | Past this a waiting run is dropped and said so                                           |

### Import, export, attachments, snapshots

| id                       |       default |     min |         max | scope    | admin | why                                                     |
| ------------------------ | ------------: | ------: | ----------: | -------- | ----- | ------------------------------------------------------- |
| `import.max_rows`        |     1_000_000 | 100_000 |  10_000_000 | instance | yes   | Already an env ceiling; Administration becomes the home |
| `export.max_rows`        |     1_000_000 | 100_000 |  10_000_000 | instance | yes   | Same                                                    |
| `copy.max_rows`          |       100_000 |  10_000 |   1_000_000 | instance | yes   | Direct copy / field rewrite / keyed import              |
| `attachment.max_bytes`   |    20_971_520 |   1_024 | 524_288_000 | instance | yes   | Already in the policy; declared here                    |
| `import.text_bytes`      |   268_435_456 |       — |           — | instance | no    | Parse safety of one file; not a business knob           |
| `import.xlsx_bytes`      |    67_108_864 |       — |           — | instance | no    | Same                                                    |
| `import.json_bytes`      |    20_971_520 |       — |           — | instance | no    | Same                                                    |
| `import.max_columns`     |           200 |       — |           — | instance | no    | Same                                                    |
| `import.parse_heap_mb`   |           512 |       — |           — | instance | no    | Worker isolation (ADR 0025)                             |
| `snapshot.archive_bytes` | 2_147_483_648 |       — |           — | instance | no    | Format ceiling of one archive                           |
| `snapshot.json_bytes`    |    41_943_040 |       — |           — | instance | no    | Same                                                    |
| `snapshot.tables`        |           100 |       — |           — | instance | no    | Same                                                    |
| `snapshot.files`         |        50_000 |       — |           — | instance | no    | Same                                                    |

Staged upload TTLs (30 minutes preview, 2 hours once queued, 24 hours for a
form file) stay code constants of the staging tables: they are lifetimes of a
row, not capacity the administrator tunes day to day. They appear on the page
as read-only facts when the catalogue lists retention of transient files.

### Reads and display

| id                       |    default | min | max | scope    | admin | kind    | why                                                             |
| ------------------------ | ---------: | --: | --: | -------- | ----- | ------- | --------------------------------------------------------------- |
| `read.rows_per_page`     |      1_000 |   — |   — | instance | no    | enforce | Architectural bound of the read engine; not a dial              |
| `read.bytes_per_request` | 67_108_864 |   — |   — | instance | no    | enforce | ADR 0110; sized to the process, not the desk                    |
| `read.groups`            |      2_000 |   — |   — | instance | no    | enforce | Grouped read cost                                               |
| `display.list_rows`      |      5_000 |   — |   — | instance | no    | display | Shown on the list; raising it without a new read path would lie |
| `display.map_places`     |      5_000 |   — |   — | instance | no    | display | Same for the map                                                |
| `display.calendar_rows`  |      1_000 |   — |   — | instance | no    | display | A calendar page is one read; it already says what it left out   |
| `view.sorts`             |         10 |   — |   — | instance | no    | enforce | Schema of a view                                                |
| `view.groups`            |          5 |   — |   — | instance | no    | enforce | Same                                                            |
| `view.frozen_columns`    |         10 |   — |   — | instance | no    | enforce | Same                                                            |
| `filter.depth`           |          5 |   — |   — | instance | no    | enforce | Query shape                                                     |
| `filter.conditions`      |        100 |   — |   — | instance | no    | enforce | Same                                                            |

### Retention and security policy numbers

These keep the bounds and defaults of `POLICY_BOUNDS` and of the change-trail
retention (ADR 0069). They are declared in the catalogue so one page can list
them; the Security page remains where an administrator edits the security
ones.

| id                              |          default | min |    max | scope    | admin | why                               |
| ------------------------------- | ---------------: | --: | -----: | -------- | ----- | --------------------------------- |
| `policy.lockout_threshold`      | (policy default) |   3 |     20 | instance | yes   | Brute force floor                 |
| `policy.lockout_minutes`        | (policy default) |   5 |  1_440 | instance | yes   | 0 = until unlocked, kept as today |
| `policy.session_idle_minutes`   | (policy default) |   5 |    480 | instance | yes   | —                                 |
| `policy.session_max_hours`      | (policy default) |   1 |    168 | instance | yes   | —                                 |
| `policy.password_min_length`    | (policy default) |  12 |     64 | instance | yes   | Floor is a hard security minimum  |
| `policy.token_max_days`         | (policy default) |   1 |    365 | instance | yes   | —                                 |
| `policy.auth_retention_days`    | (policy default) | 180 |    365 | instance | yes   | CNIL floor on the sign-in trail   |
| `policy.inactive_days`          | (policy default) |  30 |    730 | instance | yes   | 0 = never, kept as today          |
| `policy.trash_days`             | (policy default) |   7 |    365 | instance | yes   | —                                 |
| `policy.restore_point_days`     | (policy default) |   1 |    365 | instance | yes   | —                                 |
| `policy.audit_retention_days`   |     0 (for ever) | 365 |  3_650 | instance | yes   | ADR 0069; 0 means for ever        |
| `policy.alert_backup_hours`     | (policy default) |   6 |    720 | instance | yes   | —                                 |
| `policy.alert_storage_percent`  | (policy default) |  50 |     99 | instance | yes   | —                                 |
| `policy.alert_certificate_days` | (policy default) |   1 |     90 | instance | yes   | —                                 |
| `policy.alert_failures`         | (policy default) |   1 | 10_000 | instance | yes   | —                                 |

### Storage quotas (roadmap 38)

| id                      |  default | min |               max | scope   | admin | why                                                  |
| ----------------------- | -------: | --: | ----------------: | ------- | ----- | ---------------------------------------------------- |
| `storage.base_bytes`    | 0 (none) |   0 | 1_099_511_627_776 | base    | yes   | 0 = no quota; set per base or as an instance default |
| `storage.account_bytes` | 0 (none) |   0 | 1_099_511_627_776 | account | yes   | Files the account uploaded across bases              |

### Auth and outbound that are already ceilings

| id                                 | default | min | max | scope    | admin | why                              |
| ---------------------------------- | ------: | --: | --: | -------- | ----- | -------------------------------- |
| `auth.mfa_attempts`                |       5 |   — |   — | account  | no    | Tied to the lockout model        |
| `auth.email_otp_attempts`          |       5 |   — |   — | account  | no    | Same                             |
| `auth.email_otp_sends_per_hour`    |       5 |   1 |  30 | account  | yes   | Mail cost; floor stops a flood   |
| `auth.pending_signups_per_address` |       3 |   — |   — | address  | no    | Anti-abuse of the signup queue   |
| `auth.waiting_guesses`             |       4 |   — |   — | account  | no    | ADR 0095                         |
| `notify.rate_per_hour`             |      20 |   5 | 200 | channel  | yes   | One notification channel         |
| `notify.failure_limit`             |       5 |   — |   — | channel  | no    | Pause after consecutive failures |
| `notify.max_channels`              |      50 |   — |   — | instance | no    | Catalogue size                   |
| `webhook.failure_limit`            |      10 |   — |   — | webhook  | no    | Same idea                        |
| `mail.operator_per_hour`           |       5 |   1 |  60 | instance | yes   | Operator broadcast               |
| `mail.operator_recipients`         |     500 |   — |   — | instance | no    | One message's size               |

### Shape of automations, scripts, cells (not dials)

These protect the model and the sandbox. They are in the catalogue so the
page can show them; an administrator cannot change them.

`automation.max_actions` (20), `automation.max_nested` (10),
`automation.max_loop_rows` (100), `automation.max_script_chars` (20_000),
`automation.max_secrets` (10), `script.time_ms` (10_000), `script.run_ms`
(60_000), `script.memory_bytes` (64 MiB), `script.max_calls` (100),
`script.at_once` (4), `cell.max_files` (20), `cell.text_chars` /
`cell.long_text_chars`, `json.max_chars`, `json.max_depth`,
`write.batch_rows` (500), `write.max_links` (500), `input.max_depth` (128),
`share.max_calls_per_request` (10), `restore_points.max` (20),
`people_file.max_bytes`, `instance_logo.max_bytes`.

## Migration order

Work lands family by family, one pull request each, with its tests; the
old constant goes in the family that moves it:

1. **Catalogue** — declare every entry (`packages/core/src/limits.ts`); the
   scattered constants are read from it, their values frozen by a test.
2. **Rate, and the page** — PostgreSQL counters; amend the in-memory path
   of ADR 0009; Administration's "Limits and usage" lists the catalogue
   with what is used where a counter exists, and edits what an
   administrator may.
3. **Jobs and sockets** — capacity in the insert; sockets counted in
   PostgreSQL.
4. **Import and export** — move env ceilings into the catalogue; Administration
   edits them.
5. **Retention** — point policy fields at the catalogue (no behaviour change).
6. **Storage** — roadmap 38, last, once file size is already the source of
   truth for consumption.

## Consequences

- ADR 0009's line "rate limits in memory per instance" is superseded for the
  count; Redis stays out.
- An instance with several API processes tells the same numbers on the Limits
  page that the refusals enforce.
- Operators who set `EXPORT_MAX_ROWS` / `IMPORT_MAX_ROWS` / `ATTACHMENT_MAX_BYTES`
  keep that bootstrap; Administration shows the pin (ADR 0083).
- The Security page and the Limits page share one source of numbers.

## Rejected

- **Redis or Valkey for counters.** ADR 0009; PostgreSQL already holds
  automation pace.
- **Keeping process-local rate limits and documenting the multiply.** The
  Limits page would lie as soon as a second process starts.
- **One admin dial for every constant.** Filter depth, script heap and read
  page size are product shape or process safety; showing them read-only is
  enough.
- **Soft quotas that only warn.** A base past its storage quota must not
  accept another file; a warning alone does not protect the disk.
