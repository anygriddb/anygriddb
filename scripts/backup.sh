#!/usr/bin/env bash
# Backs up a compose stack: its database (pg_dump, custom format), its
# files, and the instance's TLS authority, in one dated folder with their
# SHA-256 sums. The stack keeps serving while it runs.
#
# The files are where the stack keeps them: its `files` volume, or the
# volume of the object store that runs beside it (compose.s3.yml). An
# object store elsewhere is not this stack's to back up: the script says
# so, and that service's own means keep its bucket.
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
#
# Each run is reported to the instance, which shows the last ones in
# Administration and tells its administrators when backups fail or stop.
set -Eeuo pipefail

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
config="$("${compose[@]}" config --format json)"
project="$(printf '%s\n' "$config" | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -n 1)"
: "${project:?could not read the compose project name}"

# Where the files are: the stack's own volumes, as its composition names them.
volumes=(files_data tls_data)
elsewhere=""
if printf '%s\n' "$config" | grep -q '"rustfs_data"'; then
  volumes+=(rustfs_data)
elif printf '%s\n' "$config" | grep -Eq '"STORAGE_DRIVER": *"s3"'; then
  elsewhere=yes
fi

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

# Tells the instance how this run ended. A report that cannot be made
# never fails the backup: the instance then finds, later, that it is late.
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
report() {
  local flags=() bytes
  if [ "$1" = failed ]; then flags+=(--failed); fi
  bytes="$(du -sk "$out" 2>/dev/null | cut -f1)" || bytes=""
  case "$bytes" in '' | *[!0-9]*) ;; *) flags+=(--bytes "$((bytes * 1024))") ;; esac
  if [ -n "$recipient" ]; then flags+=(--encrypted); fi
  "${compose[@]}" exec -T app anygriddb backups record \
    --name "$(basename "$out")" --started "$started" ${flags[@]+"${flags[@]}"} >/dev/null 2>&1 ||
    echo "The instance could not be told of this run: Administration will not show it." >&2
}
trap 'trap - ERR; report failed' ERR

echo "== Database ${POSTGRES_DB}"
"${compose[@]}" exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom | keep "$out/database.dump"

archives=("database.dump$suffix")
for volume in "${volumes[@]}"; do
  echo "== Volume ${project}_${volume}"
  # The archive comes out on stdout: the file is the operator's, not root's.
  docker run --rm --network none -v "${project}_${volume}:/volume:ro" \
    postgres:18 tar -C /volume -czf - . | keep "$out/${volume}.tar.gz"
  archives+=("${volume}.tar.gz$suffix")
done

(cd "$out" && sha256sum "${archives[@]}" >SHA256SUMS)
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
if [ -n "$elsewhere" ]; then
  echo "The files of this stack are in an object store outside it: this backup does not hold them. Keep that bucket with its service's own means." >&2
fi
trap - ERR
report succeeded
