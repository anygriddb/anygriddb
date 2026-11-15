#!/usr/bin/env bash
# Idempotent load of sample databases into the anygriddb-lab containers.
# Without a flag: the four databases the sample suites read (Chinook,
# Northwind, Sakila, Pagila), which is what those suites ask for.
# --lab adds the ones the lab alone loads: DVD Rental on PostgreSQL, World
# and Employees (some four million rows) on MySQL and MariaDB. The SQL
# Server backups come one flag each: restore one large sample at a time,
# since the three together exhaust the lab's SQL Server.
# Usage: ./scripts/lab/seed.sh [--lab] [--adventureworks]
#   [--wideworldimporters] [--wideworldimporters-dw] [--all]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LAB="$ROOT/docker/lab"
SEEDS="$LAB/seeds"
# An explicit LAB_PASSWORD wins over docker/lab/.env (the sample suites
# pass theirs to containers they start).
if [[ -z "${LAB_PASSWORD:-}" ]]; then
  # shellcheck disable=SC1091
  source "$LAB/.env" 2>/dev/null || true
fi
PASSWORD="${LAB_PASSWORD:-Lab!Admin-2026}"
# The compose lab's containers, or the ones a sample suite started.
PG="${LAB_PG_CONTAINER:-aglab-pg}"
MYSQL="${LAB_MYSQL_CONTAINER:-aglab-mysql}"
MARIADB="${LAB_MARIADB_CONTAINER:-aglab-mariadb}"
MSSQL="${LAB_MSSQL_CONTAINER:-aglab-mssql}"
ORACLE="${LAB_ORACLE_CONTAINER:-aglab-oracle}"
READER=anygriddb
DO_LAB=0
DO_AW=0
DO_WWI=0
DO_WWI_DW=0
for arg in "$@"; do
  case "$arg" in
    --lab) DO_LAB=1 ;;
    --adventureworks) DO_AW=1 ;;
    --wideworldimporters) DO_WWI=1 ;;
    --wideworldimporters-dw) DO_WWI_DW=1 ;;
    --all)
      # The lab's samples and one SQL Server backup: AdventureWorks and
      # the warehouse are asked for by name, one at a time.
      DO_LAB=1
      DO_WWI=1
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

FETCH_ARGS=()
[[ "$DO_LAB" -eq 1 ]] && FETCH_ARGS+=(--lab)
[[ "$DO_AW" -eq 1 ]] && FETCH_ARGS+=(--adventureworks)
[[ "$DO_WWI" -eq 1 || "$DO_WWI_DW" -eq 1 ]] && FETCH_ARGS+=(--wideworldimporters)
"$ROOT/scripts/lab/fetch-seeds.sh" "${FETCH_ARGS[@]+"${FETCH_ARGS[@]}"}"

need() {
  if ! docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true; then
    echo "Container $1 is not running. Start with: ./scripts/lab/up.sh [--mssql] [--oracle]" >&2
    return 1
  fi
}

echo "==> Chinook + Northwind + Pagila on PostgreSQL"
need "$PG"
docker cp "$SEEDS/chinook/Chinook_PostgreSql.sql" "$PG":/tmp/Chinook_PostgreSql.sql
docker exec "$PG" psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/Chinook_PostgreSql.sql >/tmp/aglab-seed-pg-chinook.log
docker exec "$PG" psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='northwind' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
docker exec "$PG" psql -U postgres -c "DROP DATABASE IF EXISTS northwind;"
docker exec "$PG" psql -U postgres -c "CREATE DATABASE northwind WITH ENCODING='UTF8' TEMPLATE=template0;"
docker cp "$SEEDS/northwind/northwind.pgsql.sql" "$PG":/tmp/northwind.sql
docker exec "$PG" bash -c "sed -n '/^DROP TABLE/,\$p' /tmp/northwind.sql | psql -U postgres -d northwind -v ON_ERROR_STOP=1" >/tmp/aglab-seed-pg-northwind.log
docker exec "$PG" psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='pagila' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
docker exec "$PG" psql -U postgres -c "DROP DATABASE IF EXISTS pagila;"
docker exec "$PG" psql -U postgres -c "CREATE DATABASE pagila;"
docker cp "$SEEDS/pagila/pagila-schema.sql" "$PG":/tmp/pagila-schema.sql
docker cp "$SEEDS/pagila/pagila-data.sql" "$PG":/tmp/pagila-data.sql
docker exec "$PG" psql -U postgres -d pagila -v ON_ERROR_STOP=1 -f /tmp/pagila-schema.sql >/tmp/aglab-seed-pg-pagila-schema.log
docker exec "$PG" psql -U postgres -d pagila -v ON_ERROR_STOP=1 -f /tmp/pagila-data.sql >/tmp/aglab-seed-pg-pagila-data.log
if [[ "$DO_LAB" -eq 1 ]]; then
  echo "==> DVD Rental on PostgreSQL"
  docker exec "$PG" psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='dvdrental' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  docker exec "$PG" psql -U postgres -c "DROP DATABASE IF EXISTS dvdrental;"
  docker exec "$PG" psql -U postgres -c "CREATE DATABASE dvdrental;"
  docker cp "$SEEDS/dvdrental/dvdrental.sql" "$PG":/tmp/dvdrental.sql
  docker exec "$PG" psql -U postgres -d dvdrental -v ON_ERROR_STOP=1 -f /tmp/dvdrental.sql >/tmp/aglab-seed-pg-dvdrental.log
fi

echo "==> Chinook + Northwind + Sakila on MySQL"
need "$MYSQL"
docker cp "$SEEDS/chinook/Chinook_MySql.sql" "$MYSQL":/tmp/Chinook_MySql.sql
docker exec "$MYSQL" bash -c "mysql -uroot -p'$PASSWORD' < /tmp/Chinook_MySql.sql" >/tmp/aglab-seed-mysql-chinook.log
docker cp "$SEEDS/northwind/northwind.mysql.sql" "$MYSQL":/tmp/northwind.sql
docker exec "$MYSQL" bash -c "mysql -uroot -p'$PASSWORD' < /tmp/northwind.sql" >/tmp/aglab-seed-mysql-northwind.log
docker cp "$SEEDS/sakila/sakila-schema.sql" "$MYSQL":/tmp/sakila-schema.sql
docker cp "$SEEDS/sakila/sakila-data.sql" "$MYSQL":/tmp/sakila-data.sql
docker exec "$MYSQL" bash -c "mysql -uroot -p'$PASSWORD' < /tmp/sakila-schema.sql && mysql -uroot -p'$PASSWORD' < /tmp/sakila-data.sql" >/tmp/aglab-seed-mysql-sakila.log
if [[ "$DO_LAB" -eq 1 ]]; then
  echo "==> World + Employees on MySQL"
  docker cp "$SEEDS/world/world.sql" "$MYSQL":/tmp/world.sql
  docker exec "$MYSQL" bash -c "mysql -uroot -p'$PASSWORD' < /tmp/world.sql" >/tmp/aglab-seed-mysql-world.log
  work=$(mktemp -d)
  tar -xzf "$SEEDS/employees/test_db-1.0.7.tar.gz" -C "$work"
  docker exec "$MYSQL" rm -rf /tmp/test_db
  docker cp "$work/test_db-1.0.7" "$MYSQL":/tmp/test_db
  rm -rf "$work"
  docker exec "$MYSQL" bash -c "cd /tmp/test_db && mysql -uroot -p'$PASSWORD' < employees.sql" >/tmp/aglab-seed-mysql-employees.log
fi

echo "==> Chinook + Northwind + Sakila on MariaDB"
need "$MARIADB"
docker cp "$SEEDS/chinook/Chinook_MySql.sql" "$MARIADB":/tmp/Chinook_MySql.sql
docker exec "$MARIADB" bash -c "mariadb -uroot -p'$PASSWORD' < /tmp/Chinook_MySql.sql" >/tmp/aglab-seed-maria-chinook.log
docker cp "$SEEDS/northwind/northwind.mariadb.sql" "$MARIADB":/tmp/northwind.sql
docker exec "$MARIADB" bash -c "mariadb -uroot -p'$PASSWORD' < /tmp/northwind.sql" >/tmp/aglab-seed-maria-northwind.log
docker cp "$SEEDS/sakila/sakila-schema.sql" "$MARIADB":/tmp/sakila-schema.sql
docker cp "$SEEDS/sakila/sakila-data.sql" "$MARIADB":/tmp/sakila-data.sql
docker exec "$MARIADB" bash -c "mariadb -uroot -p'$PASSWORD' < /tmp/sakila-schema.sql && mariadb -uroot -p'$PASSWORD' < /tmp/sakila-data.sql" >/tmp/aglab-seed-maria-sakila.log
if [[ "$DO_LAB" -eq 1 ]]; then
  echo "==> World + Employees on MariaDB"
  docker cp "$SEEDS/world/world.sql" "$MARIADB":/tmp/world.sql
  docker exec "$MARIADB" bash -c "mariadb -uroot -p'$PASSWORD' < /tmp/world.sql" >/tmp/aglab-seed-maria-world.log
  work=$(mktemp -d)
  tar -xzf "$SEEDS/employees/test_db-1.0.7.tar.gz" -C "$work"
  docker exec "$MARIADB" rm -rf /tmp/test_db
  docker cp "$work/test_db-1.0.7" "$MARIADB":/tmp/test_db
  rm -rf "$work"
  docker exec "$MARIADB" bash -c "cd /tmp/test_db && mariadb -uroot -p'$PASSWORD' < employees.sql" >/tmp/aglab-seed-maria-employees.log
fi

if docker inspect -f '{{.State.Running}}' "$MSSQL" 2>/dev/null | grep -q true; then
  echo "==> Chinook + Northwind on SQL Server"
  docker exec "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -Q "
IF EXISTS (SELECT name FROM sys.databases WHERE name = N'Chinook')
BEGIN ALTER DATABASE [Chinook] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [Chinook]; END
IF EXISTS (SELECT name FROM sys.databases WHERE name = N'northwind')
BEGIN ALTER DATABASE [northwind] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [northwind]; END
"
  docker cp "$SEEDS/chinook/Chinook_SqlServer.sql" "$MSSQL":/tmp/Chinook_SqlServer.sql
  docker exec "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -i /tmp/Chinook_SqlServer.sql >/tmp/aglab-seed-mssql-chinook.log
  docker exec "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -Q "CREATE DATABASE [northwind];"
  docker cp "$SEEDS/northwind/northwind.mssql.sql" "$MSSQL":/tmp/northwind.sql
  docker exec "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -d northwind -i /tmp/northwind.sql >/tmp/aglab-seed-mssql-northwind.log

  if [[ "$DO_AW" -eq 1 ]]; then
    echo "==> AdventureWorks2022 on SQL Server"
    BAK="$SEEDS/adventureworks/AdventureWorks2022.bak"
    docker exec "$MSSQL" mkdir -p /var/opt/mssql/backup
    docker cp "$BAK" "$MSSQL":/var/opt/mssql/backup/AdventureWorks2022.bak
    docker exec "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -Q "
IF EXISTS (SELECT name FROM sys.databases WHERE name = N'AdventureWorks2022')
BEGIN ALTER DATABASE [AdventureWorks2022] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [AdventureWorks2022]; END
RESTORE DATABASE [AdventureWorks2022]
FROM DISK = N'/var/opt/mssql/backup/AdventureWorks2022.bak'
WITH MOVE N'AdventureWorks2022' TO N'/var/opt/mssql/data/AdventureWorks2022.mdf',
     MOVE N'AdventureWorks2022_log' TO N'/var/opt/mssql/data/AdventureWorks2022_log.ldf',
     REPLACE;
"
  fi

  if [[ "$DO_WWI" -eq 1 ]]; then
    echo "==> WideWorldImporters (OLTP) on SQL Server"
    docker exec "$MSSQL" mkdir -p /var/opt/mssql/backup /var/opt/mssql/data
    docker cp "$SEEDS/wideworldimporters/WideWorldImporters-Full.bak" \
      "$MSSQL":/var/opt/mssql/backup/WideWorldImporters-Full.bak
    docker exec "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -Q "
IF EXISTS (SELECT name FROM sys.databases WHERE name = N'WideWorldImporters')
BEGIN ALTER DATABASE [WideWorldImporters] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [WideWorldImporters]; END
RESTORE DATABASE [WideWorldImporters]
FROM DISK = N'/var/opt/mssql/backup/WideWorldImporters-Full.bak'
WITH MOVE N'WWI_Primary' TO N'/var/opt/mssql/data/WideWorldImporters.mdf',
     MOVE N'WWI_UserData' TO N'/var/opt/mssql/data/WideWorldImporters_UserData.ndf',
     MOVE N'WWI_Log' TO N'/var/opt/mssql/data/WideWorldImporters.ldf',
     MOVE N'WWI_InMemory_Data_1' TO N'/var/opt/mssql/data/WideWorldImporters_InMemory_Data_1',
     REPLACE;
"
  fi
  if [[ "$DO_WWI_DW" -eq 1 ]]; then
    echo "==> WideWorldImportersDW (OLAP) on SQL Server"
    docker exec "$MSSQL" mkdir -p /var/opt/mssql/backup /var/opt/mssql/data
    docker cp "$SEEDS/wideworldimporters/WideWorldImportersDW-Full.bak" \
      "$MSSQL":/var/opt/mssql/backup/WideWorldImportersDW-Full.bak
    docker exec "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -Q "
IF EXISTS (SELECT name FROM sys.databases WHERE name = N'WideWorldImportersDW')
BEGIN ALTER DATABASE [WideWorldImportersDW] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [WideWorldImportersDW]; END
RESTORE DATABASE [WideWorldImportersDW]
FROM DISK = N'/var/opt/mssql/backup/WideWorldImportersDW-Full.bak'
WITH MOVE N'WWI_Primary' TO N'/var/opt/mssql/data/WideWorldImportersDW.mdf',
     MOVE N'WWI_UserData' TO N'/var/opt/mssql/data/WideWorldImportersDW_UserData.ndf',
     MOVE N'WWI_Log' TO N'/var/opt/mssql/data/WideWorldImportersDW.ldf',
     MOVE N'WWIDW_InMemory_Data_1' TO N'/var/opt/mssql/data/WideWorldImportersDW_InMemory_Data_1',
     REPLACE;
"
  fi
else
  echo "==> SQL Server container not running; skip MSSQL seeds (./scripts/lab/up.sh --mssql)"
fi

if docker inspect -f '{{.State.Running}}' "$ORACLE" 2>/dev/null | grep -q true; then
  echo "==> Chinook on Oracle Free (schema CHINOOK in FREEPDB1)"
  # Upstream script targets a CDB common user (c##chinook). Lab uses a local
  # PDB user CHINOOK; strip the CDB account dance and load tables as CHINOOK.
  body=/tmp/aglab-Chinook_Oracle_body.sql
  awk 'BEGIN{p=0} /^CREATE TABLE/{p=1} p && !/^conn /{print}' \
    "$SEEDS/chinook/Chinook_Oracle.sql" >"$body"
  docker cp "$body" "$ORACLE":/tmp/Chinook_Oracle_body.sql
  # sqlplus runs as oracle; docker cp leaves the file root-owned.
  docker exec -u 0 "$ORACLE" chmod 644 /tmp/Chinook_Oracle_body.sql
  docker exec -i "$ORACLE" sqlplus -s "system/\"${PASSWORD}\"@//localhost/FREEPDB1" <<SQL >/tmp/aglab-seed-oracle-user.log
WHENEVER SQLERROR EXIT SQL.SQLCODE
BEGIN
  EXECUTE IMMEDIATE 'DROP USER chinook CASCADE';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE != -1918 THEN RAISE; END IF;
END;
/
CREATE USER chinook IDENTIFIED BY "${PASSWORD}" QUOTA UNLIMITED ON users;
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE, CREATE PROCEDURE TO chinook;
EXIT;
SQL
  docker exec -i "$ORACLE" sqlplus -s "chinook/\"${PASSWORD}\"@//localhost/FREEPDB1" <<SQL >/tmp/aglab-seed-oracle-chinook.log
WHENEVER SQLERROR EXIT SQL.SQLCODE
SET DEFINE OFF
@/tmp/Chinook_Oracle_body.sql
COMMIT;
EXIT;
SQL
else
  echo "==> Oracle container not running; skip Oracle seeds (./scripts/lab/up.sh --oracle)"
fi

echo "==> Least-privilege grants for $READER"
"$ROOT/scripts/lab/grants.sh"

echo "==> MySQL/MariaDB time zone tables (CONVERT_TZ)"
if docker inspect -f '{{.State.Running}}' "$MYSQL" 2>/dev/null | grep -q true; then
  docker exec "$MYSQL" bash -c "mysql_tzinfo_to_sql /usr/share/zoneinfo 2>/dev/null | mysql -uroot -p'$PASSWORD' mysql" >/tmp/aglab-tz-mysql.log 2>&1 || true
fi
if docker inspect -f '{{.State.Running}}' "$MARIADB" 2>/dev/null | grep -q true; then
  docker exec "$MARIADB" bash -c "mariadb-tzinfo-to-sql /usr/share/zoneinfo 2>/dev/null | mariadb -uroot -p'$PASSWORD' mysql" >/tmp/aglab-tz-maria.log 2>&1 || true
fi

echo "==> Seed complete"
echo "    TLS CA for AnyGridDB: $LAB/certs/ca.crt"
echo "    ANYGRIDDB_LAB_HOST=127.0.0.1 ANYGRIDDB_LAB_TLS_CA=$LAB/certs/ca.crt pnpm test:samples"
