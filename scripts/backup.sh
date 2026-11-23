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
#   scripts/backup.sh -p name -f compose.yml -f compose.s3.yml
#
# Options go to `docker compose` as they are, read from docker/: a
# Compose file is named as it is there, without the folder. Settings come from
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
# A run that stops before its end leaves nothing behind.
set -euo pipefail
# What this run writes is its owner's alone from the first byte.
umask 077

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/docker"

env_file="${ENV_FILE:-.env}"
args=("$@")
if [[ ${#args[@]} -eq 0 ]]; then args=(-f compose.yml); fi

# Tells the instance how this run ended, through its running container:
# that takes nothing from .env, which may be what stopped the run. A report
# that cannot be made never fails the backup: the instance then finds,
# later, that it is late.
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out=""
project=""
recipient=""
report() {
  local flags=() bytes name="${project:-backup}-${stamp}" container=""
  if [[ -n "$out" ]]; then name="$(basename "$out")"; fi
  if [[ "$1" = failed ]]; then flags+=(--failed); fi
  if [[ -n "$out" ]]; then
    bytes="$(du -sk "$out" 2>/dev/null | cut -f1)" || bytes=""
    case "$bytes" in '' | *[!0-9]*) ;; *) flags+=(--bytes "$((bytes * 1024))") ;; esac
  fi
  if [[ -n "$recipient" ]]; then flags+=(--encrypted); fi
  # Before .env is read the project's name comes from the options alone.
  if [[ -z "$project" ]]; then
    project="$(docker compose --env-file /dev/null "${args[@]}" config --no-interpolate 2>/dev/null |
      sed -n 's/^name: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' | head -n 1)" || project=""
    name="${project:-backup}-${stamp}"
  fi
  if [[ -n "$project" ]]; then
    container="$(docker ps -q --filter "label=com.docker.compose.project=$project" \
      --filter label=com.docker.compose.service=app --filter status=running 2>/dev/null | head -n 1)" || container=""
  fi
  if [[ -z "$container" ]] || ! docker exec "$container" anygriddb backups record \
    --name "$name" --started "$started" ${flags[@]+"${flags[@]}"} >/dev/null 2>&1; then
    echo "The instance could not be told of this run: Administration will not show it." >&2
  fi
}
# The instance is told once, where the script ends, of what became of the
# backup: made, or not. A run that stops before its backup is made leaves
# nothing: a folder with part of a dump is no backup, and holds what a
# backup holds. Told where a command failed, a failure while a file was
# written was told twice.
made=""
ended() {
  status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$made" ]]; then
    report succeeded
  else
    if [[ -n "$out" ]]; then rm -rf -- "$out"; fi
    echo "This run stopped before its end: nothing is kept of it." >&2
    report failed
  fi
  exit "$status"
}
trap ended EXIT
# Stopped from outside, the run ends the same way: a signal that ends the
# shell by itself would skip what the end has to do.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# shellcheck source=scripts/env-file.sh
. "$root/scripts/env-file.sh"
read_env_file "$env_file" POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD \
  AUTH_ENCRYPTION_KEY POSTGRES_PASSWORD_FILE AUTH_ENCRYPTION_KEY_FILE \
  BACKUP_DIR BACKUP_AGE_RECIPIENT BACKUP_KEEP_DAYS
# An install that keeps its secrets in files (scripts/install.sh).
# shellcheck source=scripts/secret-files.sh
. "$root/scripts/secret-files.sh"
load_secret_files "$(cd "$(dirname "$env_file")" && pwd)"
: "${POSTGRES_USER:?set POSTGRES_USER in docker/.env}"
: "${POSTGRES_DB:?set POSTGRES_DB in docker/.env}"

recipient="${BACKUP_AGE_RECIPIENT:-}"
if [[ -n "$recipient" ]]; then
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

compose=(docker compose "${args[@]}")
if [[ -f "$env_file" ]]; then compose=(docker compose --env-file "$env_file" "${args[@]}"); fi
config="$("${compose[@]}" config --format json)"
# The project's name is the composition's own `name`, at its top: a
# config, a network or a volume has a name too, further in.
project="$("${compose[@]}" config | sed -n 's/^name: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' | head -n 1)"
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
out="$backups/${project}-${stamp}"
mkdir -p "$out"
chmod 700 "$out"

# Writes stdin to the file, encrypted as it comes when a recipient is set.
suffix=""
if [[ -n "$recipient" ]]; then suffix=".age"; fi
keep() {
  if [[ -n "$recipient" ]]; then
    age -r "$recipient" >"$1$suffix"
  else
    cat >"$1"
  fi
}

# Docker makes a volume that is named and is not there: archived, it
# would be a backup of nothing that says it went well.
for volume in "${volumes[@]}"; do
  if ! docker volume inspect "${project}_${volume}" >/dev/null 2>&1; then
    echo "The stack ${project} has no volume ${project}_${volume}: give the options the stack runs with." >&2
    exit 1
  fi
done

echo "== Database ${POSTGRES_DB}"
"${compose[@]}" exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom | keep "$out/database.dump"

archives=("database.dump$suffix")
for volume in "${volumes[@]}"; do
  echo "== Volume ${project}_${volume}"
  # The archive comes out on stdout: the file is the operator's, not root's.
  docker run --rm --network none -v "${project}_${volume}:/volume:ro" \
    postgres:18 tar -C /volume --exclude='./.ag-restore-*' -czf - . | keep "$out/${volume}.tar.gz"
  archives+=("${volume}.tar.gz$suffix")
done

(cd "$out" && sha256sum "${archives[@]}" >SHA256SUMS)
chmod 600 "$out"/*
made=yes
echo
echo "Backup: $out"
du -sh "$out" | cut -f1

if [[ -n "$keep_days" ]]; then
  # Folders are named by when they were made, in UTC: older names sort first.
  cutoff="$(date -u -d "-${keep_days} days" +%Y%m%dT%H%M%SZ 2>/dev/null ||
    date -u -v-"${keep_days}"d +%Y%m%dT%H%M%SZ)"
  for folder in "$backups/${project}"-*; do
    name="$(basename "$folder")"
    stamp="${name#"${project}"-}"
    [[ -d "$folder" ]] && [[ "$folder" != "$out" ]] || continue
    [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    if [[ "$stamp" < "$cutoff" ]]; then
      rm -rf -- "$folder"
      echo "Removed, older than ${keep_days} days: $name"
    fi
  done
fi

if [[ -n "$recipient" ]]; then
  echo "Encrypted for ${recipient}: restore it with that key's identity (BACKUP_AGE_IDENTITY)."
fi
echo "Keep AUTH_ENCRYPTION_KEY apart from it: without that key, this backup's sealed secrets stay sealed."
if [[ -n "$elsewhere" ]]; then
  echo "The files of this stack are in an object store outside it: this backup does not hold them. Keep that bucket with its service's own means." >&2
fi
