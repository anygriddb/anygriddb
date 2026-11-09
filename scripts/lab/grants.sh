#!/usr/bin/env bash
# Create least-privilege anygriddb login + side schema on each running lab engine.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LAB="$ROOT/docker/lab"
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

# --- PostgreSQL ---
if docker inspect -f '{{.State.Running}}' "$PG" 2>/dev/null | grep -q true; then
  docker exec -i "$PG" psql -U postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${READER}') THEN
    CREATE ROLE ${READER} LOGIN PASSWORD '${PASSWORD}';
  ELSE
    ALTER ROLE ${READER} WITH LOGIN PASSWORD '${PASSWORD}';
  END IF;
END
\$\$;
SQL
  for db in chinook northwind pagila; do
    docker exec -i "$PG" psql -U postgres -d "$db" <<SQL
GRANT CONNECT ON DATABASE ${db} TO ${READER};
GRANT USAGE ON SCHEMA public TO ${READER};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READER};
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${READER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${READER};
CREATE SCHEMA IF NOT EXISTS anygriddb_side;
GRANT USAGE, CREATE ON SCHEMA anygriddb_side TO ${READER};
-- Sandbox writes for samples suites (safe Chinook playlist tables).
DO \$\$
BEGIN
  IF to_regclass('public.playlist') IS NOT NULL THEN
    GRANT INSERT, UPDATE, DELETE ON public.playlist TO ${READER};
    GRANT INSERT, UPDATE, DELETE ON public.playlist_track TO ${READER};
  END IF;
  IF to_regclass('public.genre') IS NOT NULL THEN
    GRANT UPDATE (name) ON public.genre TO ${READER};
  END IF;
END
\$\$;
SQL
  done
  echo "  postgres: grants ok"
fi

# --- MySQL ---
if docker inspect -f '{{.State.Running}}' "$MYSQL" 2>/dev/null | grep -q true; then
  docker exec -i "$MYSQL" mysql -uroot -p"$PASSWORD" <<SQL
CREATE USER IF NOT EXISTS '${READER}'@'%' IDENTIFIED BY '${PASSWORD}';
ALTER USER '${READER}'@'%' IDENTIFIED BY '${PASSWORD}';
CREATE DATABASE IF NOT EXISTS ag_side;
GRANT CREATE, ALTER, SELECT, INSERT, UPDATE, DELETE ON ag_side.* TO '${READER}'@'%';
GRANT SELECT ON Chinook.* TO '${READER}'@'%';
GRANT SELECT ON northwind.* TO '${READER}'@'%';
GRANT SELECT ON sakila.* TO '${READER}'@'%';
GRANT INSERT, UPDATE, DELETE ON Chinook.Playlist TO '${READER}'@'%';
GRANT INSERT, UPDATE, DELETE ON Chinook.PlaylistTrack TO '${READER}'@'%';
GRANT UPDATE (Name) ON Chinook.Genre TO '${READER}'@'%';
FLUSH PRIVILEGES;
SQL
  echo "  mysql: grants ok"
fi

# --- MariaDB ---
if docker inspect -f '{{.State.Running}}' "$MARIADB" 2>/dev/null | grep -q true; then
  docker exec -i "$MARIADB" mariadb -uroot -p"$PASSWORD" <<SQL
CREATE USER IF NOT EXISTS '${READER}'@'%' IDENTIFIED BY '${PASSWORD}';
ALTER USER '${READER}'@'%' IDENTIFIED BY '${PASSWORD}';
CREATE DATABASE IF NOT EXISTS ag_side;
GRANT CREATE, ALTER, SELECT, INSERT, UPDATE, DELETE ON ag_side.* TO '${READER}'@'%';
GRANT SELECT ON Chinook.* TO '${READER}'@'%';
GRANT SELECT ON northwind.* TO '${READER}'@'%';
GRANT SELECT ON sakila.* TO '${READER}'@'%';
GRANT INSERT, UPDATE, DELETE ON Chinook.Playlist TO '${READER}'@'%';
GRANT INSERT, UPDATE, DELETE ON Chinook.PlaylistTrack TO '${READER}'@'%';
GRANT UPDATE (Name) ON Chinook.Genre TO '${READER}'@'%';
FLUSH PRIVILEGES;
SQL
  echo "  mariadb: grants ok"
fi

# --- SQL Server ---
if docker inspect -f '{{.State.Running}}' "$MSSQL" 2>/dev/null | grep -q true; then
  docker exec -i "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C <<SQL
IF NOT EXISTS (SELECT name FROM sys.server_principals WHERE name = N'anygriddb')
  CREATE LOGIN [anygriddb] WITH PASSWORD = N'${PASSWORD}';
ELSE
  ALTER LOGIN [anygriddb] WITH PASSWORD = N'${PASSWORD}';
SQL
  for db in Chinook northwind; do
    docker exec -i "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -d "$db" <<SQL
IF NOT EXISTS (SELECT name FROM sys.database_principals WHERE name = N'anygriddb')
  CREATE USER [anygriddb] FOR LOGIN [anygriddb];
GRANT SELECT ON SCHEMA::dbo TO [anygriddb];
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = N'anygriddb_side')
  EXEC('CREATE SCHEMA anygriddb_side');
GRANT CREATE TABLE TO [anygriddb];
GRANT ALTER, SELECT, INSERT, UPDATE, DELETE ON SCHEMA::anygriddb_side TO [anygriddb];
IF OBJECT_ID(N'dbo.Playlist', N'U') IS NOT NULL
BEGIN
  GRANT INSERT, UPDATE, DELETE ON dbo.Playlist TO [anygriddb];
  GRANT INSERT, UPDATE, DELETE ON dbo.PlaylistTrack TO [anygriddb];
END
IF OBJECT_ID(N'dbo.Genre', N'U') IS NOT NULL
  GRANT UPDATE ON dbo.Genre (Name) TO [anygriddb];
SQL
  done
  if docker exec "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -h -1 -Q "SET NOCOUNT ON; SELECT name FROM sys.databases WHERE name=N'AdventureWorks2022';" 2>/dev/null | grep -q AdventureWorks2022; then
    docker exec -i "$MSSQL" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -d AdventureWorks2022 <<SQL
IF NOT EXISTS (SELECT name FROM sys.database_principals WHERE name = N'anygriddb')
  CREATE USER [anygriddb] FOR LOGIN [anygriddb];
GRANT SELECT ON SCHEMA::Person TO [anygriddb];
GRANT SELECT ON SCHEMA::Production TO [anygriddb];
GRANT SELECT ON SCHEMA::Sales TO [anygriddb];
GRANT SELECT ON SCHEMA::HumanResources TO [anygriddb];
GRANT SELECT ON SCHEMA::Purchasing TO [anygriddb];
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = N'anygriddb_side')
  EXEC('CREATE SCHEMA anygriddb_side');
GRANT CREATE TABLE TO [anygriddb];
GRANT ALTER, SELECT, INSERT, UPDATE, DELETE ON SCHEMA::anygriddb_side TO [anygriddb];
SQL
  fi
  echo "  sqlserver: grants ok"
fi
