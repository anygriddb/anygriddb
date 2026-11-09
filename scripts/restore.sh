#!/usr/bin/env bash
# Restores a backup scripts/backup.sh made into a compose stack: the
# database, the files, and the instance's TLS authority. What the stack
# holds now is replaced. The stack needs the same AUTH_ENCRYPTION_KEY as
# the one the backup was made with.
#
#   scripts/restore.sh data/backups/anygriddb-20261108T120000Z
#   scripts/restore.sh <folder> -p name -f docker/compose.yml
#
# Options after the folder go to `docker compose` as they are. Settings
# come from docker/.env, or the file ENV_FILE names.
set -euo pipefail

backup="$(cd "${1:?usage: scripts/restore.sh <backup folder> [compose options]}" && pwd)"
shift
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/docker"

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
compose=(docker compose "${args[@]}")
if [ -f "$env_file" ]; then compose=(docker compose --env-file "$env_file" "${args[@]}"); fi
project="$("${compose[@]}" config --format json | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -n 1)"
: "${project:?could not read the compose project name}"

echo "== Checking ${backup}"
(cd "$backup" && sha256sum --check --quiet SHA256SUMS)

echo "== Stopping AnyGridDB"
"${compose[@]}" stop app >/dev/null 2>&1 || true
"${compose[@]}" up -d --wait db

echo "== Database ${POSTGRES_DB}: replaced by the backup's"
"${compose[@]}" exec -T db dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB"
"${compose[@]}" exec -T db createdb -U "$POSTGRES_USER" "$POSTGRES_DB"
"${compose[@]}" exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --no-owner --no-privileges --exit-on-error <"$backup/database.dump"

for volume in files_data tls_data; do
  echo "== Volume ${project}_${volume}: replaced by the backup's"
  docker run --rm -i --network none -v "${project}_${volume}:/volume" \
    postgres:18 sh -c "find /volume -mindepth 1 -delete && tar -C /volume -xzf -" \
    <"$backup/${volume}.tar.gz"
done

echo "== Starting AnyGridDB"
"${compose[@]}" up -d --wait
echo
echo "Restored from $backup."
