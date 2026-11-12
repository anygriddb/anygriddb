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
# come from docker/.env, or the file ENV_FILE names. A backup encrypted
# with age (BACKUP_AGE_RECIPIENT) needs BACKUP_AGE_IDENTITY, the path of
# the matching identity file: every file is decrypted once, to check it,
# before anything is replaced.
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

suffix=""
identity="${BACKUP_AGE_IDENTITY:-}"
if [ -f "$backup/database.dump.age" ]; then
  suffix=".age"
  : "${identity:?this backup is encrypted: set BACKUP_AGE_IDENTITY to its age identity file}"
  command -v age >/dev/null || {
    echo "This backup is encrypted: install age (https://age-encryption.org) first." >&2
    exit 1
  }
  for file in database.dump files_data.tar.gz tls_data.tar.gz; do
    age -d -i "$identity" "$backup/$file.age" >/dev/null
  done
fi
# A file of the backup, decrypted as it is read when it is encrypted.
read_back() {
  if [ -n "$suffix" ]; then
    age -d -i "$identity" "$1$suffix"
  else
    cat "$1"
  fi
}

echo "== Stopping AnyGridDB"
"${compose[@]}" stop app >/dev/null 2>&1 || true
"${compose[@]}" up -d --wait db

echo "== Database ${POSTGRES_DB}: replaced by the backup's"
"${compose[@]}" exec -T db dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB"
"${compose[@]}" exec -T db createdb -U "$POSTGRES_USER" "$POSTGRES_DB"
read_back "$backup/database.dump" |
  "${compose[@]}" exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --no-owner --no-privileges --exit-on-error

for volume in files_data tls_data; do
  echo "== Volume ${project}_${volume}: replaced by the backup's"
  read_back "$backup/${volume}.tar.gz" |
    docker run --rm -i --network none -v "${project}_${volume}:/volume" \
      postgres:18 sh -c "find /volume -mindepth 1 -delete && tar -C /volume -xzf -"
done

# The services' certificates come from the authority just restored: the
# database starts again with the ones `certs` issues from it, or a stack
# other than the one backed up would refuse its own database.
"${compose[@]}" stop db >/dev/null

echo "== Starting AnyGridDB"
"${compose[@]}" up -d --wait
echo
echo "Restored from $backup."
