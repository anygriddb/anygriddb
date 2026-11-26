# Connecting a client database

PostgreSQL, MySQL, MariaDB, SQL Server, or Oracle live (ADRs 0006, 0026).
Stores without SQL: [from a copy](#stores-that-speak-no-sql).

**Before declaring a source**

1. **Dedicated non-admin account.** Refused: PostgreSQL superuser; MySQL /
   MariaDB global grants beyond rows; SQL Server sysadmin / CONTROL SERVER;
   Oracle DBA / SYSDBA. Catalog lists only what the account may read (cap
   2,000 tables, 1,000 for copy stores; search reaches the rest).
2. **Verifiable TLS.** System-trusted CA, or paste server CA / self-signed
   cert naming the host as AnyGridDB reaches it. Verification cannot be
   turned off. `ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT=true` = development only.
3. **`ANYGRIDDB_SOURCES_ALLOWED_HOSTS`** (names, `*.` domains, IPs, ranges).
   Empty = no sources. Network kill switch; drivers ship in every image.

Emptying / removing a host:

- **Live tables** and **bases held in a source** (ADR 0090): R/W fail until
  allowed again; catalog stays.
- **Synced / copy stores** (ADR 0034, 0088): last copy keeps serving;
  refreshes fail.

Replica hosts must both be allowed. Synced table before first copy is live
(refused like live if host blocked). Administration → Sources shows impact.

Reads: source time limit + connection cap, read-only txn where available.
Timeless dates use the source timezone (UTC default). Optional **read
replica**: reads there with primary fallback; writes stay on primary.

## Writes

Off until enabled per table (ADR 0028). Needs PK + matching grants;
column-level update rights apply.

```sql
-- PostgreSQL
grant update (status, issued) on public.invoices to anygriddb;
grant insert on public.customers to anygriddb;
grant usage on sequence public.customers_id_seq to anygriddb;
-- MySQL, MariaDB
grant update (status, issued) on erp.invoices to 'anygriddb'@'%';
-- SQL Server
grant update on dbo.invoices (status, issued) to anygriddb;
-- Oracle
grant select, update (status, issued) on erp.invoices to anygriddb;
grant select, insert on erp.customers to anygriddb;
```

Imports use the same path (keyed updates). DB refusals reported per line.
Writes are compare-and-set under row lock, three-step trail (intent /
applied / confirmed). External app changes are not in that history.

## A base held in a SQL source

Admin-only. PostgreSQL / MySQL / MariaDB / SQL Server. Not Oracle, not copy
stores. Schema name fixed (`ag` + base id fragment).

| Engine         | Extra rights                                  |
| -------------- | --------------------------------------------- |
| PostgreSQL     | `CREATE` on the database                      |
| MySQL, MariaDB | ``GRANT ALL ON `ag%`.*`` (not a global grant) |
| SQL Server     | `CREATE SCHEMA` + `CREATE TABLE`              |

Failure creates neither base nor schema. Stored fields are columns; formula /
button stay in AnyGridDB. Multiple select, duration, collaborator,
attachment, links, lookups, rollups, and row meta are not offered there.
Members, views, dashboards, files, comments, history stay in AnyGridDB.

Rename base ≠ rename schema. No starting-point sample rows. Permanent delete
of field/table drops the source object; permanent delete of the base keeps
the schema unless an admin types its name. Existing client tables are never
rewritten by expose.

## Reading a copy instead

Source page → Lecture → **Copie dans AnyGridDB** + interval (ADR 0034).

- Refresh: 1k rows / short read-only txns; grids/webhooks/automations get
  add/change/delete. No watch column needed. Read-only; live until first
  copy; cap 1M rows. Link to a still-live table shows empty — copy both.
- **Incremental**: change column (`updated_at` / SQL Server `rowversion`);
  full copy every N refreshes (default 24) to catch deletes.

## Stores that speak no SQL

Copy only (ADR 0088): whole table, 1k rows/batch, default hourly. No writes,
no side schema, no replica. Cap 1M rows. Field types inferred from rows;
mismatched values read empty (counted); **Refresh fields** re-infers.

### The MongoDB wire protocol

Tested on FerretDB 2 (MongoDB-compatible protocol; MongoDB server not in
suite). Port 27017. Connects only to the named host (no replica discovery).

```js
db.getSiblingDB("erp").createUser({
  user: "anygriddb",
  pwd: passwordPrompt(),
  roles: [{ role: "read", db: "erp" }],
});
```

Refuses deployment/account admin roles when the server reports them.
Collection → table; `_id` → row; top-level field → column. Types from 200
newest docs. Nested/list → JSON. Skip: name > 63 bytes / control chars,
fields past 300, collections past 1,000.

### OpenSearch

Tested on OpenSearch 2. Port 9200. **Indices** pattern (`orders-*`); empty =
all open (hidden `.` indices skipped). Read-only account; refuses
`all_access` / `security_manager` when reported. No redirect following.
Index → table; mapping types; object/multi → JSON. Same name/field/index
caps as above.

## Statuses and signatures

State in AnyGridDB only (ADR 0033, 0137) — no client DDL. Needs PK. The
table's circuit is its own, compliance until changed; what a state forbids
(a change, some fields, a delete) is refused through AnyGridDB; other apps
can still change the client table. A sealed state seals the row: SHA-256
of stored fields (incl. `updated_at` / `rowversion`). Job compares every 5
min (or seconds if watched). Mismatch → grid mark + notify those who moved
or signed it, and owners; a step out of the sealed state before a new one.
DBA triggers to hard-block are theirs; AnyGridDB installs none.

## Fields AnyGridDB adds

Side schema on the client DB (ADR 0032); client tables untouched. Admin
names the schema in the source form.

```sql
-- PostgreSQL
create schema anygriddb_side;
grant usage, create on schema anygriddb_side to anygriddb;
-- MySQL, MariaDB
create database anygriddb_side;
grant create, alter, select, insert, update, delete
  on anygriddb_side.* to 'anygriddb'@'%';
-- SQL Server
create schema anygriddb_side;
grant create table to anygriddb;
grant alter, select, insert, update, delete
  on schema::anygriddb_side to anygriddb;
-- Oracle: account schema in capitals (ANYGRIDDB)
grant create table to anygriddb;
alter user anygriddb quota 100m on users;
```

Editable even when the client table is read-only. Without a side schema,
fields live in AnyGridDB by row key (ADR 0046): filter yes (AND, ≤ 1k
matches); no sort/group; formulas/automations/rules do not read them.
Existing fields stay where made.

## Oracle

19c+, thin driver (no client install). Form takes **service name**. Sees
every schema the account may read.

```sql
create user anygriddb identified by "…";
grant create session to anygriddb;
grant select on erp.orders to anygriddb;
```

TLS over TCPS (2484 typical); paste listener CA. Client cert not required
(`SSL_CLIENT_AUTHENTICATION = FALSE`). Session: UTC, `.` decimal, code-point
compare.

| Quirk                                            | Behaviour                                          |
| ------------------------------------------------ | -------------------------------------------------- |
| Empty text                                       | `''` is NULL                                       |
| Text length                                      | 4k / 32k extended; over → blank cell + length note |
| `NUMBER`                                         | no scale; `NUMBER(p)` refuses decimals             |
| `NUMBER(1)` / `BOOLEAN`                          | checkbox when constrained to 0/1                   |
| `DATE`                                           | day only (midnight); use `TIMESTAMP` for time      |
| Regex formulas                                   | refused (no lookahead; `$` before final NL)        |
| Locks                                            | 10 s wait                                          |
| `RAW`/`BLOB`/intervals/`ROWID`/`XMLTYPE`/spatial | read-only text; `JSON` read-only long text         |

## When the DBA changes a table

**Refresh fields** on the table (or after a failed grid read). New columns →
fields (FK → link when target exposed); type follow when type changed under
same name. Enum/check lists followed. Dropped column → trash. PK change
followed; no PK → writes stop.

SQL Server check text needs:

```sql
grant view definition on dbo.orders to anygriddb;
```

## Changes made elsewhere

Per-table watch (ADR 0031) → grids + webhooks/automations (`source:
external`). Needs PK. AnyGridDB's own writes not double-told.

- **Change column**: `updated_at` or SQL Server `rowversion` (index it).
  Sees add/change, not delete.

```sql
-- MySQL, MariaDB
alter table erp.orders add column updated_at datetime(3) not null
  default current_timestamp(3) on update current_timestamp(3);
-- SQL Server
alter table dbo.orders add rv rowversion;
-- PostgreSQL: trigger with clock_timestamp() (not now())
```

- **SQL Server Change Tracking** (includes deletes):

```sql
alter database erp set change_tracking = on
  (change_retention = 2 days, auto_cleanup = on);
alter table dbo.orders enable change_tracking;
grant view change tracking on dbo.orders to anygriddb;
```

Keep retention longer than AnyGridDB downtime. Rows ahead of engine clock
told once; page warns if > 1 day ahead.

## PostgreSQL (13 or later)

```sql
create role anygriddb login password '…';
grant connect on database erp to anygriddb;
grant usage on schema public to anygriddb;
grant select on public.customers, public.invoices to anygriddb;
-- or: grant select on all tables in schema public to anygriddb;
-- alter default privileges in schema public grant select on tables to anygriddb;
```

`ssl = on` + certs; `pg_hba.conf`:

```
hostssl  erp  anygriddb  10.0.0.0/8  scram-sha-256
```

Paste CA in the form when not system-trusted.

## MySQL (8.0.16 or later) and MariaDB (10.6 or later)

Pick the real engine (checked on save). Older versions refused.

```sql
create user 'anygriddb'@'%' identified by '…' require ssl;
grant select on erp.customers to 'anygriddb'@'%';
grant select on erp.invoices to 'anygriddb'@'%';
```

Cert must name the host (`require_secure_transport = ON`). Auto-generated
MySQL cert has no hostname → replace. Time zone tables required:

```sh
mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root mysql
```

- `tinyint(1)` → checkbox; `enum` → single select.
- `TIME` as text (incl. >24 h / negative); binary/blob → `0x` hex, first 1k B.
- Text filter/sort follows column collation (accent/case-blind defaults
  match `e`/`É`); use `_bin` / `_as_cs` to distinguish. Formulas always
  code-point.
- FK links need `FOREIGN KEY … REFERENCES` (inline `REFERENCES` ignored).
- MariaDB `JSON` → long text to a read-only account.
- SQRT/EXP/LN/LOG/POWER → float, 15 sig digits (ADR 0027).

## SQL Server (2017 or later)

SQL login only (no Windows auth).

```sql
create login anygriddb with password = '…';
use erp;
create user anygriddb for login anygriddb;
grant select on schema::dbo to anygriddb;
```

Force encryption (`mssql.conf` on Linux: `tlscert` / `tlskey` /
`forceencryption = 1`). No read-only txn — grants enforce reads.

- `money`/`smallmoney` four decimals; `datetime2(7)` / `datetimeoffset(7)`
  keep 7 fractional digits.
- `varchar` code-page limited → use `nvarchar` / `_UTF8`.
- Zones via Windows names (CLDR). Numbers ≤ 38 digits; SQRT/EXP/… float 15
  sig digits where noted on the field.

## Sample database lab

Chinook, Northwind, Sakila, Pagila, AdventureWorks on five engines over TLS:
[`docker/lab/README.md`](../docker/lab/README.md).

```bash
./scripts/lab/up.sh --mssql
./scripts/lab/seed.sh --all
ANYGRIDDB_LAB_HOST=127.0.0.1 \
ANYGRIDDB_LAB_TLS_CA="$PWD/docker/lab/certs/ca.crt" \
  pnpm test:samples
```
