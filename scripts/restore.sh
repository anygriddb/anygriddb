#!/usr/bin/env bash
# Restores a backup scripts/backup.sh made into a compose stack: the
# database, the files, and the instance's TLS authority. The stack needs
# the same AUTH_ENCRYPTION_KEY as the one the backup was made with (or that
# key in AUTH_ENCRYPTION_PREVIOUS_KEYS), and the composition the backup was
# made from: a backup that holds an object store's files goes back into a
# stack that runs one (-f compose.yml -f compose.s3.yml).
#
#   scripts/restore.sh data/backups/anygriddb-20261108T120000Z
#   scripts/restore.sh <folder> -p name -f compose.yml -f compose.s3.yml
#
# Options after the folder go to `docker compose` as they are, read from
# docker/: a Compose file is named as it is there, without the folder.
#
# What the stack holds is replaced only once the backup has proved itself,
# while the application keeps serving: SHA256SUMS covers every file, each
# archive and the dump read to their end, there is room for a second copy,
# the dump restores whole into a temporary database, and the key in place
# opens what the backup sealed. Then the application stops, the new data
# takes the place of the old by renaming, and the old is removed once the
# application has started healthy. Any failure before that puts back what
# was there and starts it again.
#
#   --in-place          When there is no room for two copies: the same
#                       checks of the files, then the data is replaced
#                       directly. A failure then cannot be undone.
#   --keep-store-files  A backup without the object store's files, on a
#                       stack that runs one: the files it has now stay.
#
# Exits 3 when the key in place does not open the backup, 4 when there is
# no room for two copies, 1 on any other refusal or failure. Those options
# come right after the folder; what follows goes to `docker compose` as it
# is. Settings come from docker/.env, or the file ENV_FILE names. A backup
# encrypted with age (BACKUP_AGE_RECIPIENT) needs BACKUP_AGE_IDENTITY, the
# path of the matching identity file. RESTORE_START_SECONDS is how long the
# application is given to start healthy (600 by default).
set -euo pipefail

backup="$(cd "${1:?usage: scripts/restore.sh <backup folder> [--in-place] [--keep-store-files] [compose options]}" && pwd)"
shift
in_place=""
keep_store=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --in-place) in_place=yes ;;
    --keep-store-files) keep_store=yes ;;
    *) break ;;
  esac
  shift
done
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/docker"

env_file="${ENV_FILE:-.env}"
# shellcheck source=scripts/env-file.sh
. "$root/scripts/env-file.sh"
read_env_file "$env_file" POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD \
  AUTH_ENCRYPTION_KEY POSTGRES_PASSWORD_FILE AUTH_ENCRYPTION_KEY_FILE \
  BACKUP_AGE_IDENTITY
# An install that keeps its secrets in files (scripts/install.sh).
# shellcheck source=scripts/secret-files.sh
. "$root/scripts/secret-files.sh"
load_secret_files "$(cd "$(dirname "$env_file")" && pwd)"
: "${POSTGRES_USER:?set POSTGRES_USER in docker/.env}"
: "${POSTGRES_DB:?set POSTGRES_DB in docker/.env}"

args=("$@")
if [[ ${#args[@]} -eq 0 ]]; then args=(-f compose.yml); fi
compose=(docker compose "${args[@]}")
if [[ -f "$env_file" ]]; then compose=(docker compose --env-file "$env_file" "${args[@]}"); fi
config="$("${compose[@]}" config --format json)"
# The project's name is the composition's own `name`, at its top: a
# config, a network or a volume has a name too, further in.
project="$("${compose[@]}" config | sed -n 's/^name: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' | head -n 1)"
: "${project:?could not read the compose project name}"

# The temporary database, the one it replaced until the application has
# started, and that one once it is no longer needed. While the second
# exists a switch is under way: it is what a later run goes by.
new_db=anygriddb_restore_new
old_db=anygriddb_restore_old
spent_db=anygriddb_restore_spent
case "$POSTGRES_DB" in
  "$new_db" | "$old_db" | "$spent_db")
    echo "POSTGRES_DB may not be $POSTGRES_DB: this script keeps that name for its own use." >&2
    exit 1
    ;;
esac
maintenance=postgres
if [[ "$POSTGRES_DB" = postgres ]]; then maintenance=template1; fi
proof_volume="${project}_restore_tls"

say() { printf '== %s\n' "$*"; }
refuse() {
  echo "$1" >&2
  exit "${2:-1}"
}

# What the environment or a container says is taken for a number only once
# it is digits: in arithmetic, bash runs what such a value holds.
whole_number() {
  case "${1:-}" in
    '' | *[!0-9]*) refuse "$2 is not a number." ;;
  esac
}
whole_number "${RESTORE_START_SECONDS:-600}" RESTORE_START_SECONDS

suffix=""
identity="${BACKUP_AGE_IDENTITY:-}"
if [[ -f "$backup/database.dump.age" ]]; then suffix=".age"; fi

# The volumes this restore replaces, and the files the backup must hold.
volumes=(files_data tls_data)
store=""
if printf '%s\n' "$config" | grep -q '"rustfs_data"'; then store=yes; fi
if [[ -f "$backup/rustfs_data.tar.gz$suffix" ]] && [[ -z "$store" ]]; then
  refuse "This backup holds an object store's files: restore it into a stack that runs one (-f compose.yml -f compose.s3.yml)."
fi
if [[ -n "$store" ]] && [[ -z "$keep_store" ]]; then
  if [[ ! -f "$backup/rustfs_data.tar.gz$suffix" ]]; then
    refuse "This stack runs an object store and this backup holds none of its files. To restore the rest and leave the store's files as they are: --keep-store-files."
  fi
  volumes+=(rustfs_data)
fi
wanted=("database.dump$suffix")
for volume in "${volumes[@]}"; do wanted+=("${volume}.tar.gz$suffix"); done

sum_of() {
  if command -v sha256sum >/dev/null; then
    sha256sum <"$1" | cut -d' ' -f1
  else
    shasum -a 256 <"$1" | cut -d' ' -f1
  fi
}

# Compares the list with the files itself: `sha256sum --check` of macOS
# passes an empty or unreadable list, and none says what a list left out.
prove_sums() {
  local line sum name known item listed=" "
  local format='^([0-9a-fA-F]{64})[[:space:]]+[*]?([^[:space:]].*)$'
  if [[ ! -r "$backup/SHA256SUMS" ]]; then
    refuse "$backup has no readable SHA256SUMS: not a whole backup."
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ -z "$line" ]]; then continue; fi
    if [[ ! "$line" =~ $format ]]; then
      refuse "SHA256SUMS holds a line that is not a sum: this backup cannot be checked."
    fi
    sum="$(printf '%s' "${BASH_REMATCH[1]}" | tr 'A-F' 'a-f')"
    name="${BASH_REMATCH[2]}"
    known=""
    for item in "${wanted[@]}" "rustfs_data.tar.gz$suffix"; do
      if [[ "$item" = "$name" ]]; then known=yes; fi
    done
    if [[ -z "$known" ]]; then refuse "SHA256SUMS names $name, which is no file of a backup."; fi
    if [[ ! -f "$backup/$name" ]]; then refuse "$name is in SHA256SUMS and not in the backup."; fi
    if [[ "$(sum_of "$backup/$name")" != "$sum" ]]; then
      refuse "$name does not match its sum: this file is damaged."
    fi
    listed="$listed$name "
  done <"$backup/SHA256SUMS"
  if [[ "$listed" = " " ]]; then refuse "SHA256SUMS lists nothing: this backup cannot be checked."; fi
  for item in "${wanted[@]}"; do
    case "$listed" in
      *" $item "*) ;;
      *) refuse "SHA256SUMS does not list $item: this backup cannot be checked whole." ;;
    esac
  done
}
prove_sums

if [[ -n "$suffix" ]]; then
  : "${identity:?this backup is encrypted: set BACKUP_AGE_IDENTITY to its age identity file}"
  command -v age >/dev/null || refuse "This backup is encrypted: install age (https://age-encryption.org) first."
fi
# A file of the backup, decrypted as it is read when it is encrypted.
read_back() {
  if [[ -n "$suffix" ]]; then
    age -d -i "$identity" "$1$suffix"
  else
    cat "$1"
  fi
}

# What is running now: what a failure has to leave running.
is_running() {
  [[ -n "$("${compose[@]}" ps -q --status running "$1" 2>/dev/null </dev/null || true)" ]]
}
app_ran=""
db_ran=""
if is_running app; then app_ran=yes; fi
if is_running db; then db_ran=yes; fi

stage=proving
in_db() {
  "${compose[@]}" exec -T db psql -X -q -v ON_ERROR_STOP=1 -U "$db_admin" -d "$maintenance" "$@"
}
database_exists() {
  [[ "$("${compose[@]}" exec -T db psql -X -At -U "$db_admin" -d "$maintenance" \
    -c "select 1 from pg_database where datname = '$1'" </dev/null)" = 1 ]]
}
drop_database() {
  in_db --set=name="$1" >/dev/null <<'SQL'
SET client_min_messages = warning;
DROP DATABASE IF EXISTS :"name" WITH (FORCE);
SQL
}
in_volume() {
  docker run --rm -i --network none -v "${project}_$1:/volume" postgres:18 sh -c "$2"
}

# Back as they were, from what the volume holds: an interrupted run comes
# here too. `.ag-restore-moved` says everything old has left the root, so
# what is there now came from the backup.
# shellcheck disable=SC2016 # run in the container, where it expands
VOLUME_BACK='set -e
cd /volume
if [ -f .ag-restore-moved ]; then
  find . -mindepth 1 -maxdepth 1 ! -name ".ag-restore-*" -exec rm -rf -- {} +
  rm -f .ag-restore-moved
fi
if [ -d .ag-restore-old ]; then
  find .ag-restore-old -mindepth 1 -maxdepth 1 -exec mv -t . -- {} +
  rmdir .ag-restore-old
fi
if [ -f .ag-restore-root ]; then
  chown "$(cut -d" " -f1 .ag-restore-root)" .
  chmod "$(cut -d" " -f2 .ag-restore-root)" .
  rm -f .ag-restore-root
fi
rm -rf .ag-restore-new'

# The database alone first: `certs`, run on a TLS volume caught midway,
# would issue a new authority there. It runs only when the database has no
# certificate yet, on a stack that never started.
start_database() {
  if is_running db; then return 0; fi
  "${compose[@]}" up -d --wait --no-deps db 2>/dev/null || "${compose[@]}" up -d --wait db
}

put_back() {
  local volume failed="" back="$VOLUME_BACK" held
  "${compose[@]}" stop app >/dev/null 2>&1
  if [[ -n "$store" ]]; then "${compose[@]}" stop rustfs >/dev/null 2>&1; fi
  start_database >/dev/null 2>&1
  if ! held="$("${compose[@]}" exec -T db psql -X -At -U "$db_admin" -d "$maintenance" \
    -c "select count(*) from pg_database where datname = '$old_db'" </dev/null)"; then
    echo "The database cannot be reached to put things back. Nothing more was changed: run this script again once it answers." >&2
    return 1
  fi
  # No old database: the switch was not made, or it is over. Either way
  # the old files are not to come back.
  if [[ "$held" = 0 ]]; then back='rm -rf /volume/.ag-restore-new'; fi
  for volume in files_data tls_data ${store:+rustfs_data}; do
    if docker volume inspect "${project}_${volume}" >/dev/null 2>&1; then
      in_volume "$volume" "$back" </dev/null || failed="$failed ${project}_${volume}"
    fi
  done
  if [[ -n "$failed" ]]; then
    echo "Could not put back the volumes:$failed. What they held is in their .ag-restore-old folder, and the database in $old_db. Run this script again to finish putting them back." >&2
    return 1
  fi
  if [[ "$held" = 1 ]]; then
    if ! in_db --set=db="$POSTGRES_DB" --set=old="$old_db" --set=new="$new_db" >/dev/null <<'SQL'; then
SET client_min_messages = warning;
DROP DATABASE IF EXISTS :"new" WITH (FORCE);
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname IN (:'db', :'old') AND pid <> pg_backend_pid();
BEGIN;
ALTER DATABASE :"db" RENAME TO :"new";
ALTER DATABASE :"old" RENAME TO :"db";
COMMIT;
SQL
      echo "Could not put the database back: it is kept as $old_db. Run this script again to finish." >&2
      return 1
    fi
  fi
  drop_database "$new_db" || true
}

# Up to `RESTORE_START_SECONDS`, until the application says it is healthy.
# One that keeps restarting will not come up: no use waiting for it.
wait_for_app() {
  local deadline id state count first=""
  deadline=$((SECONDS + ${RESTORE_START_SECONDS:-600}))
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    id="$("${compose[@]}" ps -q app 2>/dev/null | head -n 1)" || id=""
    if [[ -n "$id" ]]; then
      state="$(docker inspect -f '{{.State.Health.Status}} {{.RestartCount}}' "$id" 2>/dev/null)" || state=""
      case "$state" in healthy*) return 0 ;; esac
      count="${state##* }"
      case "$count" in
        '' | *[!0-9]*) ;;
        *)
          if [[ -z "$first" ]]; then first="$count"; fi
          if [[ $((count - first)) -ge 3 ]]; then return 1; fi
          ;;
      esac
    fi
    sleep 2
  done
  return 1
}

start_what_ran() {
  if [[ -n "$app_ran" ]]; then
    # The database takes its certificate from the authority put back.
    "${compose[@]}" stop db >/dev/null 2>&1
    if "${compose[@]}" up -d app >/dev/null 2>&1 && wait_for_app; then
      echo "AnyGridDB is running again on what it held before this restore." >&2
    else
      echo "AnyGridDB did not come back by itself: its data is in place, start it with: docker compose up -d" >&2
    fi
  elif [[ -z "$db_ran" ]]; then
    "${compose[@]}" stop db >/dev/null 2>&1
  fi
}

finish() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  docker volume rm -f "$proof_volume" >/dev/null 2>&1
  case "$stage" in
    proving)
      if [[ -n "${db_admin:-}" ]]; then drop_database "$new_db" >/dev/null 2>&1; fi
      if [[ -z "$db_ran" ]] && [[ -z "$app_ran" ]]; then "${compose[@]}" stop db >/dev/null 2>&1; fi
      if [[ "$status" -ne 0 ]]; then echo "Nothing was changed." >&2; fi
      ;;
    switching)
      echo "== Putting back what was there" >&2
      if put_back; then
        start_what_ran
        echo "This restore failed: the instance holds what it held before." >&2
      fi
      ;;
    in-place)
      echo "The restore in place failed. AnyGridDB is left stopped, its data partly replaced: restore a sound backup." >&2
      ;;
  esac
  exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

say "Checking ${backup}"
if [[ -n "$suffix" ]]; then
  for name in "${wanted[@]}"; do
    age -d -i "$identity" "$backup/$name" >/dev/null ||
      refuse "$name does not decrypt with this identity."
  done
fi

start_database
db_admin="$("${compose[@]}" exec -T db psql -X -At -U "$POSTGRES_USER" -d "$maintenance" \
  -c "select rolname from pg_roles where rolsuper order by rolname = 'postgres' desc, oid limit 1" </dev/null)"
: "${db_admin:?could not find a superuser in the database}"

# A run that stopped midway, killed or with the machine: its old database
# is still there, so its switch never finished. What it held comes back
# first. Once that database is gone, what it left is only to be removed.
if database_exists "$old_db"; then
  echo "An earlier restore stopped midway: putting back what was there before it." >&2
  stage=recovering
  # The run that stopped had stopped the application for its switch.
  app_ran=yes
  put_back
  start_what_ran
  stage=proving
fi
# Stopped before its switch, it may have left the application stopped on
# data it never touched.
stopped_early=""
if [[ -z "$app_ran" ]] && database_exists "$new_db"; then stopped_early=yes; fi
drop_database "$new_db"
drop_database "$spent_db"
for volume in files_data tls_data ${store:+rustfs_data}; do
  if docker volume inspect "${project}_${volume}" >/dev/null 2>&1; then
    in_volume "$volume" 'cd /volume && rm -rf .ag-restore-new .ag-restore-old .ag-restore-moved .ag-restore-root' </dev/null
  fi
done
if [[ -n "$stopped_early" ]]; then
  echo "An earlier restore stopped before its switch: starting AnyGridDB again." >&2
  app_ran=yes
  start_what_ran
fi

# Read to their end, through gzip's own check: `tar -t` alone stops at the
# archive's last entry and does not see what comes after it.
# shellcheck disable=SC2016 # run in the container, where it expands
ARCHIVE_SIZE='set -o pipefail
gzip -dc | tar -tvf - | awk "{ bytes += \$3; entries++ } END { if (!entries) exit 1; printf \"%.0f %d\n\", bytes, entries }"'
DUMP_SIZE='set -o pipefail
pg_restore -f - | wc -c'
archive_sizes=()
for volume in "${volumes[@]}"; do
  if ! listed="$(read_back "$backup/${volume}.tar.gz" |
    docker run --rm -i --network none postgres:18 bash -c "$ARCHIVE_SIZE" 2>/dev/null)"; then
    refuse "${volume}.tar.gz cannot be read to its end: this backup is damaged."
  fi
  archive_sizes+=("$listed")
done
# The whole dump, every table's data included: its table of contents alone
# is at its start, and a dump cut further on would pass.
if ! dump_bytes="$(read_back "$backup/database.dump" |
  docker run --rm -i --network none postgres:18 bash -c "$DUMP_SIZE" 2>/dev/null)"; then
  refuse "database.dump cannot be read to its end: this backup is damaged."
fi
dump_bytes="${dump_bytes//[!0-9]/}"

# A volume this stack has not made yet would be made by `docker run`,
# outside Compose, which would then say so at every start.
for volume in "${volumes[@]}"; do
  if ! docker volume inspect "${project}_${volume}" >/dev/null 2>&1; then
    "${compose[@]}" up --no-start >/dev/null
    break
  fi
done

# Room for the second copy, by filesystem: the volumes usually share one.
# The database takes about twice the dump's text with its indexes, and
# 256 MiB of write-ahead log while it loads.
room_keys=()
room_free=()
room_need=()
need_room() {
  local i
  for ((i = 0; i < ${#room_keys[@]}; i++)); do
    if [[ "${room_keys[i]}" = "$1" ]]; then
      room_need[i]=$((room_need[i] + $3))
      return 0
    fi
  done
  room_keys+=("$1")
  room_free+=("$2")
  room_need+=("$3")
}
if [[ -z "$in_place" ]]; then
  # shellcheck disable=SC2046 # three words, meant to be split
  set -- $("${compose[@]}" exec -T db df -Pk /var/lib/postgresql </dev/null | awk 'NR == 2 { print $1 ":" $2, $4 }')
  whole_number "${2:-}" "The free space of the database's volume"
  need_room "$1" "$2" $((dump_bytes / 512 + 262144))
  for i in "${!volumes[@]}"; do
    # shellcheck disable=SC2046,SC2086 # four words, meant to be split
    set -- $(in_volume "${volumes[i]}" 'df -Pk /volume' </dev/null | awk 'NR == 2 { print $1 ":" $2, $4 }') ${archive_sizes[i]}
    whole_number "${2:-}" "The free space of ${volumes[i]}"
    whole_number "${3:-}" "The size of ${volumes[i]} in the backup"
    whole_number "${4:-}" "The file count of ${volumes[i]} in the backup"
    need_room "$1" "$2" $(($3 / 1024 + $4 * 4))
  done
  for i in "${!room_keys[@]}"; do
    if [[ "${room_need[i]}" -gt "${room_free[i]}" ]]; then
      refuse "Not enough room to keep what is there until the restore has succeeded: about $((room_need[i] / 1024)) MiB needed, $((room_free[i] / 1024)) MiB free on ${room_keys[i]%%:*}. Free some, or run again with --in-place, which cannot be undone if it fails." 4
    fi
  done
fi

# Whether the key in place opens what this backup sealed, on the backup's
# own database and authority: started under a key that does not, the
# instance would replace the authority it could not open.
prove_key() {
  local database="$1" said address
  docker volume create "$proof_volume" >/dev/null
  read_back "$backup/tls_data.tar.gz" | docker run --rm -i --network none \
    -v "$proof_volume:/tls" postgres:18 sh -c 'tar -C /tls -xzf - && chown -R 1000:1000 /tls'
  address="postgres://$(url_encode "$POSTGRES_USER"):$(url_encode "${POSTGRES_PASSWORD:-}")@db:5432/$(url_encode "$database")"
  address="$address?sslmode=verify-full&sslrootcert=/certs/internal-authority.crt"
  # By name, from this process: an address on the command line would show
  # the password to anyone who lists the host's processes.
  if ! said="$(DATABASE_URL="$address" "${compose[@]}" run --rm --no-deps -T \
    -e DATABASE_URL -e DATABASE_URL_FILE= -e DATABASE_PASSWORD_FILE= -e TLS_DIR=/restored-tls \
    -v "$proof_volume:/restored-tls:ro" app anygriddb keys status 2>&1 </dev/null)"; then
    printf '%s\n' "$said" | tail -n 4 >&2
    case "$said" in
      *"open with no key"*)
        refuse "AUTH_ENCRYPTION_KEY does not open what this backup sealed. Set the key it was made with, or add that key to AUTH_ENCRYPTION_PREVIOUS_KEYS, then run this again." 3
        ;;
    esac
    refuse "The backup's sealed values could not be checked against AUTH_ENCRYPTION_KEY."
  fi
  docker volume rm -f "$proof_volume" >/dev/null
}

if [[ -n "$in_place" ]]; then
  say "Replacing in place, as asked: a failure from here cannot be undone"
  stage=in-place
  "${compose[@]}" stop app
  if [[ -n "$store" ]]; then "${compose[@]}" stop rustfs; fi
  in_db --set=name="$POSTGRES_DB" --set=owner="$POSTGRES_USER" >/dev/null <<'SQL'
SET client_min_messages = warning;
DROP DATABASE IF EXISTS :"name" WITH (FORCE);
CREATE DATABASE :"name" OWNER :"owner" TEMPLATE template0;
SQL
  read_back "$backup/database.dump" |
    "${compose[@]}" exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --no-owner --no-privileges --exit-on-error
  prove_key "$POSTGRES_DB"
  for volume in "${volumes[@]}"; do
    say "Volume ${project}_${volume}: replaced by the backup's"
    read_back "$backup/${volume}.tar.gz" |
      in_volume "$volume" 'find /volume -mindepth 1 -delete && tar -C /volume -xzf -'
  done
  "${compose[@]}" stop db >/dev/null
  say "Starting AnyGridDB"
  "${compose[@]}" up -d
  wait_for_app || refuse "AnyGridDB did not start healthy on the restored data."
  # shellcheck disable=SC1010 # the name of the stage
  stage=done
  echo
  echo "Restored from $backup, in place."
  exit 0
fi

say "Database: the backup restored whole beside the one in service"
in_db --set=name="$new_db" --set=owner="$POSTGRES_USER" >/dev/null <<'SQL'
CREATE DATABASE :"name" OWNER :"owner" TEMPLATE template0;
SQL
read_back "$backup/database.dump" |
  "${compose[@]}" exec -T db pg_restore -U "$POSTGRES_USER" -d "$new_db" \
    --no-owner --no-privileges --exit-on-error

say "Checking AUTH_ENCRYPTION_KEY against the backup"
prove_key "$new_db"

say "Stopping AnyGridDB"
stage=switching
"${compose[@]}" stop app
if [[ -n "$store" ]]; then "${compose[@]}" stop rustfs; fi

for volume in "${volumes[@]}"; do
  say "Volume ${project}_${volume}: unpacked beside what it holds"
  read_back "$backup/${volume}.tar.gz" |
    in_volume "$volume" 'set -e; cd /volume; rm -rf .ag-restore-new; mkdir .ag-restore-new; tar -C .ag-restore-new -xzf -'
done

say "Switching to the restored data"
# Renames take no time and need the database to themselves. Together in a
# transaction: the instance's name is never without a database.
switched=""
for _ in 1 2 3 4 5; do
  if in_db --set=db="$POSTGRES_DB" --set=old="$old_db" --set=new="$new_db" >/dev/null <<'SQL'; then
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname IN (:'db', :'new') AND pid <> pg_backend_pid();
BEGIN;
ALTER DATABASE :"db" RENAME TO :"old";
ALTER DATABASE :"new" RENAME TO :"db";
COMMIT;
SQL
    switched=yes
    break
  fi
  sleep 2
done
if [[ -z "$switched" ]]; then refuse "The database could not be switched: something keeps it open."; fi

# The old content moves aside first, whole, then the new takes the root,
# with the owner and mode the backup gave it.
for volume in "${volumes[@]}"; do
  in_volume "$volume" 'set -e
cd /volume
stat -c "%u:%g %a" . > .ag-restore-root
mkdir -p .ag-restore-old
find . -mindepth 1 -maxdepth 1 ! -name ".ag-restore-*" -exec mv -t .ag-restore-old -- {} +
: > .ag-restore-moved
find .ag-restore-new -mindepth 1 -maxdepth 1 -exec mv -t . -- {} +
chown --reference=.ag-restore-new .
chmod --reference=.ag-restore-new .' </dev/null
done

# The services' certificates come from the authority just restored: the
# database starts again with the ones `certs` issues from it, or a stack
# other than the one backed up would refuse its own database.
"${compose[@]}" stop db >/dev/null

say "Starting AnyGridDB"
"${compose[@]}" up -d
wait_for_app || refuse "AnyGridDB did not start healthy on the restored data."

# From here the restore has succeeded: what remains is only to remove the
# old copy, and a failure at it changes nothing that matters.
trap '' HUP INT TERM
in_db --set=old="$old_db" --set=spent="$spent_db" >/dev/null <<'SQL'
ALTER DATABASE :"old" RENAME TO :"spent";
SQL
# shellcheck disable=SC1010 # the name of the stage
stage=done
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for volume in "${volumes[@]}"; do
  in_volume "$volume" 'cd /volume && rm -rf .ag-restore-new .ag-restore-old .ag-restore-moved .ag-restore-root' </dev/null ||
    echo "Could not remove the old files of ${project}_${volume}: its .ag-restore-old folder can go." >&2
done
drop_database "$spent_db" ||
  echo "Could not remove the old database: $spent_db can go." >&2
echo
echo "Restored from $backup."
