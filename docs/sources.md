# Connecting a client database

AnyGridDB reads a client's database where it lives (ADRs 0006, 0026). An
instance administrator declares the source; the database's own
administrator (the DBA) prepares two things first:

- **A dedicated account** for AnyGridDB, never an administrator. AnyGridDB
  refuses a PostgreSQL superuser, a MySQL or MariaDB account with a global
  grant beyond rows, a SQL Server sysadmin or holder of CONTROL SERVER, and
  an Oracle DBA / SYSDBA session.
  The account's grants decide what AnyGridDB can see: it lists only the
  tables and columns the account may read.
- **TLS with a certificate AnyGridDB can verify**: one signed by an
  authority the system trusts, or the server's own authority or
  self-signed certificate, pasted in the source's form. The certificate
  must name the host as AnyGridDB reaches it (`localhost`, `db.internal`,
  an address). Nothing turns verification off.

The operator of the AnyGridDB instance lists the hosts sources may live on
in `ANYGRIDDB_SOURCES_ALLOWED_HOSTS` (names, `*.` domains, addresses,
ranges). `ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT=true` connects without TLS: for
development only, and the administration page says so.

Every read runs under the source's time limit, with at most its number of
connections, in a read-only transaction where the engine has one. Dates
and times stored without a time zone are read in the source's time zone,
set in its form (UTC by default).

A source may name a **read replica**: every read goes there (grids, the
API, copies, change checks) and falls back to the primary when the replica
cannot be reached; every write stays on the primary. Its host must be
allowed like the primary's, and its account follows the same rules. It
uses the primary's account and password unless others are set. A replica
that lags shows a change a moment after it is saved.

## Writes

A client's table is read-only until an administrator enables writes on
it, in the source's page: editing, adding, and deleting rows apart
(ADR 0028). Each needs the matching grant (`UPDATE`, `INSERT`, `DELETE`)
and a primary key; a column takes writes when the account may update it.
Grant only what people should do, for example:

```sql
-- PostgreSQL: edit two columns of invoices, add customers.
grant update (status, issued) on public.invoices to anygriddb;
grant insert on public.customers to anygriddb;
grant usage on sequence public.customers_id_seq to anygriddb;
-- MySQL, MariaDB
grant update (status, issued) on erp.invoices to 'anygriddb'@'%';
-- SQL Server
grant update on dbo.invoices (status, issued) to anygriddb;
-- Oracle: the tables of the schema `erp`
grant select, update (status, issued) on erp.invoices to anygriddb;
grant select, insert on erp.customers to anygriddb;
```

Files import into a client's table through the same path, with updates
by key. A line the database refuses (a duplicate, a missing linked row, a
check) is reported with its reason, and the other lines are written.

A change is compared with what the person saw, under a row lock, and
refused if the row moved since. What the database refuses (a required
value, a duplicate, a foreign key, a check, a trigger's error) is shown in
plain words. Every write is recorded in AnyGridDB in three steps, intent,
applied, confirmed, and shows in the row's history; changes made by other
applications do not.

## Reading a copy instead

A DBA who refuses live queries on a production database can have a table
read from a copy in AnyGridDB (ADR 0034). In the source's page, set the
table's **Lecture** to **Copie dans AnyGridDB**, and its interval in
minutes.

- The client's table is read once per interval, a thousand rows at a time
  in short read-only transactions. Everyone then reads the copy.
- Each refresh tells grids, webhooks, and automations which rows were
  added, changed, or deleted. Such a table needs no column to watch.
- The copy is read-only: changes are made in the client's database. A
  link to a table still read live shows empty; copy both tables to follow
  it.
- The table is read live until its first copy is ready. A copy stops at a
  million rows.
- **Incremental** refreshes read only the rows whose change column moved
  since the last one: a date and time the database sets on every change,
  or a SQL Server `rowversion`, as for [changes made elsewhere](#changes-made-elsewhere).
  A delete is not seen that way: every N refreshes (24 by default) the
  table is copied whole again.

## Statuses and signatures

A client's rows go from draft to submitted, locked, and signed, as
AnyGridDB's own rows do (ADR 0033). The status lives in AnyGridDB, never
in the client's table, so this needs no right beyond reading, and works
on tables AnyGridDB cannot change: a quality manager can sign the orders
of an ERP. A table needs a primary key.

A locked or signed row is refused to every change made through AnyGridDB.
Other applications can still change it in the client's database:
AnyGridDB does not change the client's schema to prevent it. What it does:

- Locking seals the row: AnyGridDB keeps every stored field's value,
  `updated_at` and `rowversion` columns included, with their SHA-256
  fingerprint. A signature records that fingerprint.
- A job compares sealed rows with the client's database every five
  minutes. On a table watched for changes made elsewhere, a changed
  sealed row is compared within seconds.
- A row that no longer matches is marked in the grid and its panel,
  with the fields that moved and their sealed values. Those who locked
  or signed it and the table's owners are notified. It cannot be signed
  until an owner unlocks it, checks it, and locks it again.

The DBA who must also refuse such changes in the database adds a trigger
of their own there; AnyGridDB never installs one.

## Fields AnyGridDB adds

People can add fields of their own to a client's table (ADR 0032): a
status, notes, a date, a score, a checkbox. They are kept in a side
table, one per exposed table, in a schema of the client's database kept
for AnyGridDB; the client's tables are never changed. The DBA creates the
schema and lets the account work there; an administrator names it in the
source's form.

```sql
-- PostgreSQL
create schema anygriddb_side;
grant usage, create on schema anygriddb_side to anygriddb;
-- MySQL, MariaDB: a database
create database anygriddb_side;
grant create, alter, select, insert, update, delete
  on anygriddb_side.* to 'anygriddb'@'%';
-- SQL Server
create schema anygriddb_side;
grant create table to anygriddb;
grant alter, select, insert, update, delete
  on schema::anygriddb_side to anygriddb;
-- Oracle: the account's own schema, named in capitals (ANYGRIDDB)
grant create table to anygriddb;
alter user anygriddb quota 100m on users;
```

These fields are edited even when the client's table is read-only, and
filter, sort, and group like the client's own columns.

Without a side schema, the fields are kept in AnyGridDB's own database,
by the row's key (ADR 0046). A view still filters on them, by value or
emptiness, combined with AND, up to a thousand matching rows; they cannot
sort or group, and formulas, automations, and rules do not read them. A
field stays where it was made: naming a side schema later puts only new
fields there, and a side schema cannot change while fields are kept in
it.

## Oracle

AnyGridDB reaches Oracle Database 19c or later with the thin driver: no
Oracle client to install. The source's form takes the **service name**
(`ORCLPDB1`, `FREEPDB1`) where the other engines take a database. The
account sees the tables and views of every schema it may read: its own,
and those granted to it, to its roles, or to `PUBLIC`.

```sql
create user anygriddb identified by "…";
grant create session to anygriddb;
grant select on erp.orders to anygriddb;
```

TLS goes over TCPS (port 2484 by convention): paste the authority that
signed the listener's certificate, which must name the host as AnyGridDB
reaches it. The listener need not ask for a client certificate
(`SSL_CLIENT_AUTHENTICATION = FALSE`).

Each session reads in UTC, with a dot before decimals, and compares text
by code point, whatever the database's defaults. What differs from the
other engines, and why:

- Oracle stores no empty text: `''` is NULL. A blank text reads as
  blank, `REPT` or `SHA256` of it as blank too, and a list built from such
  values holds nothing where the others hold an empty text.
- `NUMBER` keeps no scale: `7.50` is stored and read as `7.5`. A
  `NUMBER(p)` column refuses a value with decimals rather than round it.
- `NUMBER(1)` reads as a checkbox; so does `BOOLEAN` from 23ai.
- `DATE` also holds a time of day: it reads as a date, the day alone,
  and a date written there is at midnight. Use `TIMESTAMP` for times.
- `REGEX_MATCH`, `REGEX_EXTRACT`, and `REGEX_REPLACE` are refused, as on
  SQL Server: Oracle's expressions have no lookahead, and its `$` also
  matches before a final newline.
- Locks wait ten seconds for a row another write holds.
- `RAW`, `BLOB`, intervals, `ROWID`, `XMLTYPE`, and spatial types read as
  read-only text; `JSON` as read-only long text.

## When the DBA changes a table

A column added, dropped, or retyped in a client's table shows in
AnyGridDB once an administrator clicks **Refresh fields** on that table,
in the source's page (or under the message a grid shows when a read
fails because the table changed). New columns become fields, links when
they are foreign keys to an exposed table; a field follows its column's
type and rights under the same name, so views and formulas keep it; a
field whose column is gone goes to the trash. The table's primary key
follows too: without one, writes stop.

A text column a check limits to a list of values reads as a single
select of that list (`check (status in ('draft', 'sent'))`). SQL Server
shows a check's text only to an account allowed to see definitions:

```sql
grant view definition on dbo.orders to anygriddb;
```

## Changes made elsewhere

AnyGridDB can watch an exposed table for changes other applications make
(ADR 0031): open grids show them, and webhooks and automations receive
them as rows added, changed, or deleted, from the source `external`. An
administrator chooses how, per table, in the source's page:

- **A column the database sets on every change**: a date and time
  (`updated_at`), or a SQL Server `rowversion`. It tells rows added and
  changed, not deleted ones. Index it: each check reads the rows past
  where the last one stopped. Examples of a column kept by the database:

  ```sql
  -- MySQL, MariaDB
  alter table erp.orders add column updated_at datetime(3) not null
    default current_timestamp(3) on update current_timestamp(3);
  -- SQL Server
  alter table dbo.orders add rv rowversion;
  ```

  On PostgreSQL, a trigger sets it (`new.updated_at = clock_timestamp()`);
  `clock_timestamp()` is closer to the commit than `now()`, which is the
  transaction's start.

- **SQL Server's Change Tracking**, which tells deletes too:

  ```sql
  alter database erp set change_tracking = on
    (change_retention = 2 days, auto_cleanup = on);
  alter table dbo.orders enable change_tracking;
  grant view change tracking on dbo.orders to anygriddb;
  ```

  Keep the retention longer than AnyGridDB may be stopped: past it, the
  table is read again in full and the changes in between are not told one
  by one.

A table needs a primary key to be watched. Rows AnyGridDB itself writes
are not told twice.

## PostgreSQL (13 or later)

```sql
create role anygriddb login password '…';
grant connect on database erp to anygriddb;
grant usage on schema public to anygriddb;
-- The tables to show, or all of them:
grant select on public.customers, public.invoices to anygriddb;
-- grant select on all tables in schema public to anygriddb;
-- alter default privileges in schema public grant select on tables to anygriddb;
```

TLS: set `ssl = on` with `ssl_cert_file` and `ssl_key_file` in
`postgresql.conf`, and allow the account only over TLS in `pg_hba.conf`:

```
hostssl  erp  anygriddb  10.0.0.0/8  scram-sha-256
```

Paste the server's certificate authority (or its self-signed certificate)
in the form when it is not one the system trusts.

## MySQL (8.0.14 or later) and MariaDB (10.6 or later)

Choose the engine the server is: AnyGridDB checks, since the two differ.

```sql
create user 'anygriddb'@'%' identified by '…' require ssl;
grant select on erp.customers to 'anygriddb'@'%';
grant select on erp.invoices to 'anygriddb'@'%';
-- or every table of the database:
-- grant select on erp.* to 'anygriddb'@'%';
```

TLS: give the server a certificate that names its host (`ssl_cert`,
`ssl_key`, and `require_secure_transport = ON` in the server's
configuration). MySQL's auto-generated certificate names no host and
cannot be verified: replace it.

The server must have its **time zone tables**, which AnyGridDB needs to
read dates in the reader's zone. The official images load them; otherwise:

```sh
mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root mysql
```

Notes:

- `tinyint(1)` reads as a checkbox and an `enum` as a single select.
- A foreign key becomes a link only when the table declares it with
  `FOREIGN KEY … REFERENCES`: MySQL ignores a `REFERENCES` written in a
  column's definition.
- MariaDB's `JSON` is a `LONGTEXT` with a check that an account that only
  reads cannot see: it reads as long text.
- SQRT, EXP, LN, LOG, and POWER run in floating point on MySQL and
  MariaDB: their results are rounded to 15 significant digits, and the
  field says so (ADR 0027).

## SQL Server (2017 or later)

AnyGridDB signs in with a SQL Server login (no Windows authentication).

```sql
create login anygriddb with password = '…';
use erp;
create user anygriddb for login anygriddb;
grant select on schema::dbo to anygriddb;
-- or table by table:
-- grant select on dbo.customers to anygriddb;
```

TLS: give the instance a certificate that names its host and force
encryption (on Linux, in `mssql.conf`):

```
[network]
tlscert = /var/opt/mssql/server.crt
tlskey = /var/opt/mssql/server.key
forceencryption = 1
```

Notes:

- SQL Server has no read-only transaction: the account's grants keep
  AnyGridDB's reads reads. Grant it `SELECT`, and the writes people make.
- Time zones reach SQL Server by their Windows names, mapped from the
  reader's zone (Unicode CLDR).
- Formulas, lookups, and rollups run on SQL Server tables. T-SQL keeps at
  most 38 digits in a number and types a result by the columns' declared
  types: AnyGridDB follows those types and keeps results exact where they
  fit (a division to 20 decimals). Where a product or a quotient of wide
  columns may be rounded, the field says so. SQRT, EXP, LN, LOG, and
  POWER run in floating point, to 15 significant digits.

## Sample database lab

To exercise sources against real schemas (Chinook, Northwind, Sakila,
Pagila, AdventureWorks) on the five engines over TLS, see
[`docker/lab/README.md`](../docker/lab/README.md).

```bash
./scripts/lab/up.sh --mssql
./scripts/lab/seed.sh --all
ANYGRIDDB_LAB_HOST=127.0.0.1 \
ANYGRIDDB_LAB_TLS_CA="$PWD/docker/lab/certs/ca.crt" \
  pnpm test:samples
```

The sample suites (`apps/api/src/sources/samples/`) declare sources,
expose tables, and run reads, filters, sorts, aggregates, lookups, field
rules, writes, side fields, watches, and seals on every engine. They are
apart from the formula conformance suite, and run weekly in CI.
