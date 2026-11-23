#!/usr/bin/env bash
# Keeps an install's two secrets in files instead of .env: the database's
# password and AUTH_ENCRYPTION_KEY, each in secrets/ beside .env, with the
# database's address made from the password for the application. The
# folder is the owner's alone (0700). Its files are 0644: Compose mounts
# each one as it is, and PostgreSQL and the application read theirs as
# accounts of their own, inside their containers. Start the stack with scripts/compose.sh,
# which adds compose.secrets.yml.
#
#   scripts/install.sh                 # docker/ of this checkout
#   scripts/install.sh /srv/anygriddb  # the folder of compose.yml and .env
#
# A first install gets new random values. An install that already runs
# keeps its own: a value in .env is moved into its file, never replaced,
# since a new key would leave everything sealed with the old one unread.
# Run again, it changes nothing. It is for the database this stack runs;
# with a PostgreSQL of your own, docs/operations.md says how. Never prints
# a secret. Requires openssl.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$(cd "${1:-$root/docker}" && pwd)"
env_file="$target/.env"
secrets="$target/secrets"

if [[ ! -f "$target/compose.yml" ]]; then
  echo "install.sh: no compose.yml in $target" >&2
  exit 1
fi

if [[ ! -f "$target/compose.secrets.yml" ]]; then
  echo "install.sh: no compose.secrets.yml in $target: nothing was changed." >&2
  exit 1
fi

umask 077
if [[ ! -f "$env_file" ]]; then
  if [[ -f "$target/.env.example" ]]; then
    cp "$target/.env.example" "$env_file"
  else
    : >"$env_file"
  fi
fi
chmod 600 "$env_file"

# The values .env gives, as Compose reads them, and not what this shell
# happens to have under the same names.
unset DATABASE_URL POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD AUTH_ENCRYPTION_KEY
# shellcheck source=scripts/env-file.sh
. "$root/scripts/env-file.sh"
read_env_file "$env_file" DATABASE_URL POSTGRES_USER POSTGRES_DB \
  POSTGRES_PASSWORD AUTH_ENCRYPTION_KEY

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "install.sh: .env sets DATABASE_URL, a PostgreSQL of your own." >&2
  echo "compose.secrets.yml is for the database this stack runs." >&2
  exit 1
fi

# Whether a line of .env gives NAME a value, whatever Compose made of it.
env_names() {
  local raw
  raw="$(sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$env_file" | tail -n 1)"
  case "$raw" in '' | '""' | "''" | '#'*) return 1 ;; esac
}

# The value NAME's file is to hold: the one .env gives, the one the file
# already has, or a new one when neither does. Nothing is written yet.
secret_value() {
  local name="$1" file="$2" fresh="$3" value="${!1:-}"
  if [[ -e "$file" ]]; then
    if [[ -n "$value" ]] && [[ "$value" != "$(tr -d '\r\n' <"$file")" ]]; then
      echo "install.sh: $name in .env differs from $file. Keep one, then run again." >&2
      return 1
    fi
    tr -d '\r\n' <"$file"
  elif [[ -n "$value" ]]; then
    printf '%s' "$value"
  elif env_names "$name"; then
    # A new value in its place would leave what the old one sealed unread.
    echo "install.sh: .env names $name, and Compose reads it as empty. Correct that line, then run again." >&2
    return 1
  else
    printf '%s' "$fresh"
  fi
}

password="$(secret_value POSTGRES_PASSWORD "$secrets/postgres_password" "$(openssl rand -hex 32)")"
key="$(secret_value AUTH_ENCRYPTION_KEY "$secrets/auth_encryption_key" "$(openssl rand -base64 32)")"
user="${POSTGRES_USER:-anygriddb}"
database="${POSTGRES_DB:-anygriddb}"

# A stack that runs from this folder: the password must open its database
# before it replaces what the stack starts with. Found by the folder
# Compose started it from, so that no other stack is ever asked.
running=""
for folder in "$target" "$(cd "$target" && pwd -P)"; do
  running="$(docker ps -q --filter "label=com.docker.compose.project.working_dir=$folder" \
    --filter label=com.docker.compose.service=db --filter status=running 2>/dev/null | head -n 1)" || running=""
  if [[ -n "$running" ]]; then break; fi
done
if [[ -n "$running" ]] && ! PGPASSWORD="$password" docker exec -e PGPASSWORD -e PGSSLMODE=require \
  "$running" psql -h 127.0.0.1 -U "$user" -d "$database" -Atc 'select 1' >/dev/null 2>&1; then
  echo "install.sh: this password does not open the running stack's database: nothing was changed." >&2
  exit 1
fi

mkdir -p "$secrets"
chmod 700 "$secrets"
for pair in "postgres_password:$password" "auth_encryption_key:$key"; do
  file="$secrets/${pair%%:*}"
  if [[ ! -e "$file" ]]; then printf '%s\n' "${pair#*:}" >"$file"; fi
  chmod 644 "$file"
done

# Sets KEY=value in .env, in place of every line for KEY, `export` included.
set_env() {
  local tmp
  tmp="$(mktemp "$target/.env.XXXXXX")"
  grep -Ev "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$env_file" >"$tmp" || true
  if [[ "$#" -gt 1 ]]; then printf '%s=%s\n' "$1" "$2" >>"$tmp"; fi
  chmod 600 "$tmp"
  mv "$tmp" "$env_file"
}

if [[ -z "${POSTGRES_USER:-}" ]]; then set_env POSTGRES_USER "$user"; fi
if [[ -z "${POSTGRES_DB:-}" ]]; then set_env POSTGRES_DB "$database"; fi
set_env POSTGRES_PASSWORD
set_env AUTH_ENCRYPTION_KEY
set_env POSTGRES_PASSWORD_FILE ./secrets/postgres_password
set_env AUTH_ENCRYPTION_KEY_FILE ./secrets/auth_encryption_key

printf 'postgres://%s:%s@db:5432/%s?sslmode=verify-full&sslrootcert=/certs/internal-authority.crt\n' \
  "$(url_encode "$user")" "$(url_encode "$password")" \
  "$(url_encode "$database")" >"$secrets/database_url"
chmod 644 "$secrets/database_url"

echo "Secrets kept in $secrets; .env no longer holds them."
echo "Start, and run every compose command, with:"
echo "  $root/scripts/compose.sh --dir $target up -d"
echo "Back up and restore with the same files:"
echo "  ENV_FILE=$env_file $root/scripts/backup.sh -f $target/compose.yml -f $target/compose.secrets.yml"
