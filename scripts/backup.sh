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
# BACKUP_AGE_RECIPIENT, an age public key (age1…), encrypts each file as
# it is written: nothing readable touches the disk, and this host cannot
# read the backup back. Its identity, the private key, is kept elsewhere
# and given to scripts/restore.sh. BACKUP_KEEP_DAYS removes this stack's
# backups older than that many days, once this one has succeeded.
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

recipient="${BACKUP_AGE_RECIPIENT:-}"
if [ -n "$recipient" ]; then
  command -v age >/dev/null || {
    echo "BACKUP_AGE_RECIPIENT is set: install age (https://age-encryption.org) first." >&2
    exit 1
  }
  case "$recipient" in
    age1*) ;;
    *)
      echo "BACKUP_AGE_RECIPIENT must be an age public key (age1…)." >&2
      exit 1
      ;;
  esac
fi
keep_days="${BACKUP_KEEP_DAYS:-}"
case "$keep_days" in
  '' | [1-9] | [1-9][0-9] | [1-9][0-9][0-9]) ;;
  *)
    echo "BACKUP_KEEP_DAYS must be a number of days, 1 to 999." >&2
    exit 1
    ;;
esac

args=("$@")
if [ ${#args[@]} -eq 0 ]; then args=(-f compose.yml); fi
compose=(docker compose "${args[@]}")
if [ -f "$env_file" ]; then compose=(docker compose --env-file "$env_file" "${args[@]}"); fi
project="$("${compose[@]}" config --format json | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -n 1)"
: "${project:?could not read the compose project name}"

backups="${BACKUP_DIR:-$root/data/backups}"
out="$backups/${project}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
chmod 700 "$out"

# Writes stdin to the file, encrypted as it comes when a recipient is set.
suffix=""
if [ -n "$recipient" ]; then suffix=".age"; fi
keep() {
  if [ -n "$recipient" ]; then
    age -r "$recipient" >"$1$suffix"
  else
    cat >"$1"
  fi
}

echo "== Database ${POSTGRES_DB}"
"${compose[@]}" exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom | keep "$out/database.dump"

for volume in files_data tls_data; do
  echo "== Volume ${project}_${volume}"
  # The archive comes out on stdout: the file is the operator's, not root's.
  docker run --rm --network none -v "${project}_${volume}:/volume:ro" \
    postgres:18 tar -C /volume -czf - . | keep "$out/${volume}.tar.gz"
done

(cd "$out" && sha256sum "database.dump$suffix" "files_data.tar.gz$suffix" \
  "tls_data.tar.gz$suffix" >SHA256SUMS)
chmod 600 "$out"/*
echo
echo "Backup: $out"
du -sh "$out" | cut -f1

if [ -n "$keep_days" ]; then
  # Folders are named by when they were made, in UTC: older names sort first.
  cutoff="$(date -u -d "-${keep_days} days" +%Y%m%dT%H%M%SZ 2>/dev/null ||
    date -u -v-"${keep_days}"d +%Y%m%dT%H%M%SZ)"
  for folder in "$backups/${project}"-*; do
    name="$(basename "$folder")"
    stamp="${name#"${project}"-}"
    [ -d "$folder" ] && [ "$folder" != "$out" ] || continue
    [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    if [[ "$stamp" < "$cutoff" ]]; then
      rm -rf -- "$folder"
      echo "Removed, older than ${keep_days} days: $name"
    fi
  done
fi

if [ -n "$recipient" ]; then
  echo "Encrypted for ${recipient}: restore it with that key's identity (BACKUP_AGE_IDENTITY)."
fi
echo "Keep AUTH_ENCRYPTION_KEY apart from it: without that key, this backup's sealed secrets stay sealed."
