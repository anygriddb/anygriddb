#!/usr/bin/env bash
# Backs up a compose stack: its database (pg_dump, custom format), its
# files, and the instance's TLS authority, in one dated folder with their
# SHA-256 sums. The stack keeps serving while it runs.
#
#   scripts/backup.sh                       # the stack in docker/, project "anygriddb"
#   scripts/backup.sh -p name -f docker/compose.yml
#
# Options go to `docker compose` as they are. Settings come from
# docker/.env, or the file ENV_FILE names; the folder from BACKUP_DIR
# (default data/backups, which git ignores).
#
# AUTH_ENCRYPTION_KEY is not in the backup, on purpose: it unseals the
# sources' passwords, second factors, and TLS keys. Keep it apart.
set -euo pipefail

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

out="${BACKUP_DIR:-$root/data/backups}/${project}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
chmod 700 "$out"

echo "== Database ${POSTGRES_DB}"
"${compose[@]}" exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom >"$out/database.dump"

for volume in files_data tls_data; do
  echo "== Volume ${project}_${volume}"
  # The archive comes out on stdout: the file is the operator's, not root's.
  docker run --rm --network none -v "${project}_${volume}:/volume:ro" \
    postgres:18 tar -C /volume -czf - . >"$out/${volume}.tar.gz"
done

(cd "$out" && sha256sum database.dump files_data.tar.gz tls_data.tar.gz >SHA256SUMS)
chmod 600 "$out"/*
echo
echo "Backup: $out"
du -sh "$out" | cut -f1
echo "Keep AUTH_ENCRYPTION_KEY apart from it: without that key, this backup's sealed secrets stay sealed."
