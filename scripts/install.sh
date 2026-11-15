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

if [ ! -f "$target/compose.yml" ]; then
  echo "install.sh: no compose.yml in $target" >&2
  exit 1
fi

umask 077
if [ ! -f "$env_file" ]; then
  if [ -f "$target/.env.example" ]; then
    cp "$target/.env.example" "$env_file"
  else
    : >"$env_file"
  fi
fi
chmod 600 "$env_file"

# The value .env gives a variable, as Compose reads it: the last line wins.
env_value() {
  sed -n "s/^$1=//p" "$env_file" | tail -n 1
}

if [ -n "$(env_value DATABASE_URL)" ]; then
  echo "install.sh: .env sets DATABASE_URL, a PostgreSQL of your own." >&2
  echo "compose.secrets.yml is for the database this stack runs." >&2
  exit 1
fi

mkdir -p "$secrets"
chmod 700 "$secrets"

# Moves NAME from .env into its file, or makes the file with a new value.
keep_secret() {
  local name="$1" file="$2" fresh="$3" value
  value="$(env_value "$name")"
  if [ ! -e "$file" ]; then
    if [ -z "$value" ]; then value="$fresh"; fi
    printf '%s\n' "$value" >"$file"
  elif [ -n "$value" ] && [ "$value" != "$(tr -d '\r\n' <"$file")" ]; then
    echo "install.sh: $name in .env differs from $file. Keep one, then run again." >&2
    exit 1
  fi
  chmod 644 "$file"
}

keep_secret POSTGRES_PASSWORD "$secrets/postgres_password" \
  "$(openssl rand -hex 32)"
keep_secret AUTH_ENCRYPTION_KEY "$secrets/auth_encryption_key" \
  "$(openssl rand -base64 32)"

# Sets KEY=value in .env, in place of every line for KEY.
set_env() {
  local tmp
  tmp="$(mktemp "$target/.env.XXXXXX")"
  grep -v "^$1=" "$env_file" >"$tmp" || true
  if [ "$#" -gt 1 ]; then printf '%s=%s\n' "$1" "$2" >>"$tmp"; fi
  chmod 600 "$tmp"
  mv "$tmp" "$env_file"
}

user="$(env_value POSTGRES_USER)"
database="$(env_value POSTGRES_DB)"
if [ -z "$user" ]; then user=anygriddb && set_env POSTGRES_USER "$user"; fi
if [ -z "$database" ]; then
  database=anygriddb && set_env POSTGRES_DB "$database"
fi
set_env POSTGRES_PASSWORD
set_env AUTH_ENCRYPTION_KEY
set_env POSTGRES_PASSWORD_FILE ./secrets/postgres_password
set_env AUTH_ENCRYPTION_KEY_FILE ./secrets/auth_encryption_key

# Percent-encodes a part of the address: a password typed by hand may hold
# @, :, / or #, which would cut it.
url_encode() {
  local raw="$1" out="" i c hex
  local LC_ALL=C
  for ((i = 0; i < ${#raw}; i++)); do
    c="${raw:i:1}"
    case "$c" in
      [a-zA-Z0-9._~-]) out+="$c" ;;
      *)
        printf -v hex '%%%02X' "'$c"
        out+="$hex"
        ;;
    esac
  done
  printf '%s' "$out"
}

password="$(tr -d '\r\n' <"$secrets/postgres_password")"
printf 'postgres://%s:%s@db:5432/%s?sslmode=verify-full&sslrootcert=/certs/internal-authority.crt\n' \
  "$(url_encode "$user")" "$(url_encode "$password")" \
  "$(url_encode "$database")" >"$secrets/database_url"
chmod 644 "$secrets/database_url"

echo "Secrets kept in $secrets; .env no longer holds them."
echo "Start, and run every compose command, with:"
echo "  $root/scripts/compose.sh --dir $target up -d"
echo "Back up and restore with the same files:"
echo "  ENV_FILE=$env_file $root/scripts/backup.sh -f $target/compose.yml -f $target/compose.secrets.yml"
