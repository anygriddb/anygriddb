#!/usr/bin/env bash
# Downloads the lab's sample databases from their pinned upstream versions
# into docker/lab/seeds (not committed), and checks each file's SHA-256.
# Two MySQL fixes of Northwind are applied here, then checked too.
# Usage: ./scripts/lab/fetch-seeds.sh [--adventureworks]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SEEDS="$ROOT/docker/lab/seeds"
WITH_AW=0
for arg in "$@"; do
  case "$arg" in
    --adventureworks | --all) WITH_AW=1 ;;
  esac
done

CHINOOK=https://github.com/lerocha/chinook-database/releases/download/v1.4.5
PAGILA=https://raw.githubusercontent.com/devrimgunduz/pagila/pagila-v3.1.0
NORTHWIND=https://raw.githubusercontent.com/harryho/db-samples/9bd103fc8b12b1453c8d02571e413fc7fa65ecdb
SAKILA=https://downloads.mysql.com/docs/sakila-db.tar.gz
AW=https://github.com/Microsoft/sql-server-samples/releases/download/adventureworks/AdventureWorks2022.bak

# Fails when a file is not the one pinned.
check() {
  local expected=$1 file=$2
  local actual
  actual=$(sha256sum "$file" | cut -d' ' -f1)
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA-256 mismatch for $file: $actual, expected $expected" >&2
    rm -f "$file"
    exit 1
  fi
}

# Downloads once; a file already there is checked again.
fetch() {
  local url=$1 file=$2 expected=$3
  mkdir -p "$(dirname "$file")"
  if [[ ! -f "$file" ]]; then
    echo "==> $(basename "$file")"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  check "$expected" "$file"
}

fetch "$CHINOOK/Chinook_PostgreSql.sql" "$SEEDS/chinook/Chinook_PostgreSql.sql" \
  e3fde5c1a5b51a2a91429a702c9ca6e69ba56e6c7f5e112724d70c3d03db695e
fetch "$CHINOOK/Chinook_MySql.sql" "$SEEDS/chinook/Chinook_MySql.sql" \
  02a1835417c3ea19bff64e1d1f22be738ce51b3f88b0473c24eebff9a3ccde4b
fetch "$CHINOOK/Chinook_SqlServer.sql" "$SEEDS/chinook/Chinook_SqlServer.sql" \
  5ea75c9e925ead917d3fabea6ed3cc8c1ff1d036b61e915c94631aafa2b0802b

fetch "$PAGILA/pagila-schema.sql" "$SEEDS/pagila/pagila-schema.sql" \
  8ce358e4c8014087b85296694a0893887bd7a4190e3ce407f2721b86b98e5707
fetch "$PAGILA/pagila-data.sql" "$SEEDS/pagila/pagila-data.sql" \
  fb81bec377687c83e11d2a24916ae28656d85550bf0ada798305bf7e2af9823b

fetch "$NORTHWIND/pgsql/northwind.sql" "$SEEDS/northwind/northwind.pgsql.sql" \
  ecd1a9d2f9c3a03117c9e01406608c0c255d0437ab9dbc9c21418a0e0901aae0
fetch "$NORTHWIND/mssql/northwind.sql" "$SEEDS/northwind/northwind.mssql.sql" \
  c26608b4bab5616839bbf7498a61e0445a5c3b6960858519a507ae3068d8f3df
fetch "$NORTHWIND/mysql/northwind.sql" "$SEEDS/northwind/upstream.mysql.sql" \
  157a3acb2fccc4b30fb66e6a998fdde1a53f3b44a8da753ed9c231dcf4fe2595
# InnoDB needs orderId alone as the key OrderDetail refers to; MariaDB has
# no utf8mb4_0900_ai_ci collation.
if [[ ! -f "$SEEDS/northwind/northwind.mysql.sql" ]]; then
  sed 's/  ,PRIMARY KEY (orderId,custId)/  ,PRIMARY KEY (orderId)/' \
    "$SEEDS/northwind/upstream.mysql.sql" >"$SEEDS/northwind/northwind.mysql.sql"
fi
check 057b662f82d97b9edf27ee4d050770d1a6df78e1cd817a15230baf5657d515c4 \
  "$SEEDS/northwind/northwind.mysql.sql"
if [[ ! -f "$SEEDS/northwind/northwind.mariadb.sql" ]]; then
  sed 's/utf8mb4_0900_ai_ci/utf8mb4_unicode_ci/g' \
    "$SEEDS/northwind/northwind.mysql.sql" >"$SEEDS/northwind/northwind.mariadb.sql"
fi
check 6437de5c639afda0329556ee90a7e063f503a9f1ea9e99349702caf2eb083b80 \
  "$SEEDS/northwind/northwind.mariadb.sql"

# MySQL publishes Sakila without a version: its two files are checked.
if [[ ! -f "$SEEDS/sakila/sakila-schema.sql" || ! -f "$SEEDS/sakila/sakila-data.sql" ]]; then
  echo "==> sakila-db.tar.gz"
  mkdir -p "$SEEDS/sakila"
  work=$(mktemp -d)
  curl -fsSL --proto '=https' --tlsv1.2 -o "$work/sakila.tar.gz" "$SAKILA"
  tar -xzf "$work/sakila.tar.gz" -C "$work"
  cp "$work/sakila-db/sakila-schema.sql" "$work/sakila-db/sakila-data.sql" "$SEEDS/sakila/"
  rm -rf "$work"
fi
check b32170e1e2ad5828749b61a5ec896155bcd143104b076e5ee8a3a3b013f44915 \
  "$SEEDS/sakila/sakila-schema.sql"
check 8c228c678cec6ea9e5145ea868f48be87982252e806a547dcddb67758cadf174 \
  "$SEEDS/sakila/sakila-data.sql"

if [[ "$WITH_AW" -eq 1 ]]; then
  fetch "$AW" "$SEEDS/adventureworks/AdventureWorks2022.bak" \
    d17567adb1521f972e1dc183a7216cea869c4580b5d75632425bcadbaf82ce5e
fi

echo "==> Seeds ready in $SEEDS"
