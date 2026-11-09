#!/usr/bin/env bash
# Idempotent load of sample databases into the anygriddb-lab containers.
# Usage: ./scripts/lab/seed.sh [--adventureworks] [--all]
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
READER=anygriddb
DO_AW=0
for arg in "$@"; do
  case "$arg" in
    --adventureworks | --all) DO_AW=1 ;;
  esac
done

"$ROOT/scripts/lab/fetch-seeds.sh" $([[ "$DO_AW" -eq 1 ]] && echo --adventureworks)

need() {
  if ! docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true; then
    echo "Container $1 is not running. Start with: ./scripts/lab/up.sh [--mssql]" >&2
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

echo "==> Chinook + Northwind + Sakila on MySQL"
need "$MYSQL"
docker cp "$SEEDS/chinook/Chinook_MySql.sql" "$MYSQL":/tmp/Chinook_MySql.sql
docker exec "$MYSQL" bash -c "mysql -uroot -p'$PASSWORD' < /tmp/Chinook_MySql.sql" >/tmp/aglab-seed-mysql-chinook.log
docker cp "$SEEDS/northwind/northwind.mysql.sql" "$MYSQL":/tmp/northwind.sql
docker exec "$MYSQL" bash -c "mysql -uroot -p'$PASSWORD' < /tmp/northwind.sql" >/tmp/aglab-seed-mysql-northwind.log
docker cp "$SEEDS/sakila/sakila-schema.sql" "$MYSQL":/tmp/sakila-schema.sql
docker cp "$SEEDS/sakila/sakila-data.sql" "$MYSQL":/tmp/sakila-data.sql
docker exec "$MYSQL" bash -c "mysql -uroot -p'$PASSWORD' < /tmp/sakila-schema.sql && mysql -uroot -p'$PASSWORD' < /tmp/sakila-data.sql" >/tmp/aglab-seed-mysql-sakila.log

echo "==> Chinook + Northwind + Sakila on MariaDB"
need "$MARIADB"
docker cp "$SEEDS/chinook/Chinook_MySql.sql" "$MARIADB":/tmp/Chinook_MySql.sql
docker exec "$MARIADB" bash -c "mariadb -uroot -p'$PASSWORD' < /tmp/Chinook_MySql.sql" >/tmp/aglab-seed-maria-chinook.log
docker cp "$SEEDS/northwind/northwind.mariadb.sql" "$MARIADB":/tmp/northwind.sql
docker exec "$MARIADB" bash -c "mariadb -uroot -p'$PASSWORD' < /tmp/northwind.sql" >/tmp/aglab-seed-maria-northwind.log
docker cp "$SEEDS/sakila/sakila-schema.sql" "$MARIADB":/tmp/sakila-schema.sql
docker cp "$SEEDS/sakila/sakila-data.sql" "$MARIADB":/tmp/sakila-data.sql
docker exec "$MARIADB" bash -c "mariadb -uroot -p'$PASSWORD' < /tmp/sakila-schema.sql && mariadb -uroot -p'$PASSWORD' < /tmp/sakila-data.sql" >/tmp/aglab-seed-maria-sakila.log

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
    # Downloaded and checked by fetch-seeds.sh above.
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
else
  echo "==> SQL Server container not running; skip MSSQL seeds (./scripts/lab/up.sh --mssql)"
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
