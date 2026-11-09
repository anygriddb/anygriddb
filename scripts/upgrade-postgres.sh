#!/usr/bin/env bash
# Moves a compose stack's database from PostgreSQL 17 to 18.
#
# PostgreSQL 18 does not open a 17 cluster, and its image keeps its data
# elsewhere: the stack now runs on the `postgres_18` volume. This script
# dumps the database from the old `postgres_data` volume with a PostgreSQL
# 17 of its own, starts PostgreSQL 18 on the new volume, and restores the
# dump there. The old volume is kept, untouched, until you drop it.
#
#   scripts/upgrade-postgres.sh            # the stack in docker/, project "anygriddb"
#   scripts/upgrade-postgres.sh -p name -f docker/compose.yml -f other.yml
#
# Options after the script's name go to `docker compose` as they are.
# The database's settings come from docker/.env, as the stack reads them,
# or from the file ENV_FILE names.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/docker"

# The stack's settings: docker/.env, or the file ENV_FILE names.
env_file="${ENV_FILE:-.env}"
if [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi
: "${POSTGRES_USER:?set POSTGRES_USER in docker/.env}"
: "${POSTGRES_DB:?set POSTGRES_DB in docker/.env}"

args=("$@")
if [ ${#args[@]} -eq 0 ]; then args=(-f compose.yml); fi
compose=(docker compose --env-file "$env_file" "${args[@]}")
if [ ! -f "$env_file" ]; then compose=(docker compose "${args[@]}"); fi
project="$("${compose[@]}" config --format json | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -n 1)"
: "${project:?could not read the compose project name}"
old="${project}_postgres_data"
new="${project}_postgres_18"

say() { printf '\n== %s\n' "$*"; }

if ! docker volume inspect "$old" >/dev/null 2>&1; then
  echo "No volume $old: there is no PostgreSQL 17 data to move." >&2
  exit 1
fi
version="$(docker run --rm -v "$old:/old:ro" --network none postgres:18 cat /old/PG_VERSION 2>/dev/null || true)"
if [ "$version" != "17" ]; then
  echo "Volume $old holds PostgreSQL '${version:-nothing}', not 17: nothing done." >&2
  exit 1
fi
if docker run --rm -v "$new:/new:ro" --network none postgres:18 test -f /new/18/docker/PG_VERSION 2>/dev/null; then
  echo "Volume $new already holds a PostgreSQL 18 cluster: nothing done." >&2
  echo "Drop it (docker volume rm $new) to start the move again." >&2
  exit 1
fi

say "Stopping AnyGridDB and the database"
"${compose[@]}" stop app db >/dev/null 2>&1 || true

# Beside the stack's other local files, which git ignores (data/).
backups="${BACKUP_DIR:-$root/data/backups}"
mkdir -p "$backups"
chmod 700 "$backups"
dump="$backups/${project}-pg17-$(date -u +%Y%m%dT%H%M%SZ).dump"
helper="${project}-pg17-upgrade"

say "Dumping ${POSTGRES_DB} from PostgreSQL 17 (volume $old)"
docker rm -f "$helper" >/dev/null 2>&1 || true
# The old cluster, on its own: no network, its socket only.
docker run -d --name "$helper" --network none \
  -v "$old:/var/lib/postgresql/data" \
  -e POSTGRES_PASSWORD=unused postgres:17 >/dev/null
trap 'docker rm -f "$helper" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  if docker exec "$helper" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$helper" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom --no-owner --no-privileges >"$dump"
chmod 600 "$dump"
docker rm -f "$helper" >/dev/null
trap - EXIT
echo "Dump: $dump ($(du -h "$dump" | cut -f1))"

say "Starting PostgreSQL 18 on volume $new"
ANYGRIDDB_PG_UPGRADE=1 "${compose[@]}" up -d --wait db

say "Restoring the dump into PostgreSQL 18"
"${compose[@]}" exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --no-owner --no-privileges --exit-on-error <"$dump"

say "Starting AnyGridDB"
"${compose[@]}" up -d --wait

cat <<EOF

Done: ${POSTGRES_DB} runs on PostgreSQL 18 (volume $new).
The PostgreSQL 17 data stays in volume $old, and the dump in $dump.
Once AnyGridDB is checked, drop them:

  docker volume rm $old
  rm $dump
EOF
