#!/usr/bin/env bash
# Prepares a Docker install directory: secret files (owner-only), a .env
# without secrets, and (for the bundled Postgres stack) a database URL file.
# Re-run is safe: existing secret files are left alone; missing ones are made.
#
# Run from the directory that holds compose.yml (usually docker/), or pass
# that directory as the first argument.
#
#   ./scripts/install.sh
#   ./scripts/install.sh /path/to/docker
#
# Never prints a secret. Requires openssl.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-$root/docker}"
target="$(cd "$target" && pwd)"

secrets_dir="$target/secrets"
env_file="$target/.env"
example="$target/.env.example"

umask 077
mkdir -p "$secrets_dir"
chmod 700 "$secrets_dir"

write_secret() {
  local path="$1"
  local value="$2"
  if [ -e "$path" ]; then
    return 0
  fi
  printf '%s\n' "$value" >"$path"
  chmod 600 "$path"
}

pg_pass_file="$secrets_dir/postgres_password"
if [ ! -e "$pg_pass_file" ]; then
  write_secret "$pg_pass_file" "$(openssl rand -hex 32)"
fi

key_file="$secrets_dir/auth_encryption_key"
if [ ! -e "$key_file" ]; then
  write_secret "$key_file" "$(openssl rand -base64 32)"
fi

pg_user="anygriddb"
pg_db="anygriddb"
public_url="https://localhost:3000"
have_database_url=""
have_database_url_file=""

if [ -f "$env_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      \#* | "") continue ;;
      POSTGRES_USER=*) pg_user="${line#POSTGRES_USER=}" ;;
      POSTGRES_DB=*) pg_db="${line#POSTGRES_DB=}" ;;
      PUBLIC_URL=*) public_url="${line#PUBLIC_URL=}" ;;
      DATABASE_URL=*) have_database_url=1 ;;
      DATABASE_URL_FILE=*) have_database_url_file=1 ;;
    esac
  done <"$env_file"
fi

# Percent-encode a URL part. A password from openssl is hex; one an
# operator put in the file may hold @, :, / or #, which would break the URL.
url_encode() {
  local raw="$1" out="" i c hex
  local LC_ALL=C
  for ((i = 0; i < ${#raw}; i++)); do
    c=${raw:i:1}
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

pg_password="$(tr -d '\r\n' <"$pg_pass_file")"
database_url="postgres://$(url_encode "$pg_user"):$(url_encode "$pg_password")@db:5432/$(url_encode "$pg_db")?sslmode=verify-full&sslrootcert=/certs/internal-authority.crt"
url_file="$secrets_dir/database_url"

# Bundled stack: keep database_url in sync with the password and role names
# unless the operator already supplies DATABASE_URL for a managed Postgres.
if [ -z "$have_database_url" ]; then
  printf '%s\n' "$database_url" >"$url_file"
  chmod 600 "$url_file"
fi

if [ ! -f "$env_file" ]; then
  if [ -f "$example" ]; then
    cp "$example" "$env_file"
  else
    : >"$env_file"
  fi
  chmod 600 "$env_file"
fi

set_kv() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" "$env_file" 2>/dev/null; then
    awk -v k="$key" -v v="$value" '
      BEGIN { done = 0 }
      index($0, k "=") == 1 {
        print k "=" v
        done = 1
        next
      }
      { print }
      END { if (!done) print k "=" v }
    ' "$env_file" >"$tmp"
  else
    cat "$env_file" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
}

clear_kv() {
  local key="$1"
  local tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$env_file" >"$tmp" || true
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
}

set_kv "POSTGRES_USER" "$pg_user"
set_kv "POSTGRES_DB" "$pg_db"
set_kv "PUBLIC_URL" "$public_url"
set_kv "POSTGRES_PASSWORD_FILE" "./secrets/postgres_password"
set_kv "AUTH_ENCRYPTION_KEY_FILE" "./secrets/auth_encryption_key"
if [ -z "$have_database_url" ]; then
  set_kv "DATABASE_URL_FILE" "./secrets/database_url"
fi

for key in POSTGRES_PASSWORD AUTH_ENCRYPTION_KEY \
  AUTH_ENCRYPTION_PREVIOUS_KEYS METRICS_TOKEN SMTP_PASSWORD OIDC_CLIENT_SECRET \
  S3_SECRET_KEY S3_ACCESS_KEY OTEL_EXPORTER_OTLP_HEADERS; do
  clear_kv "$key"
done
if [ -z "$have_database_url" ]; then
  clear_kv "DATABASE_URL"
fi

# Silence unused when managed URL was already set.
: "${have_database_url_file:=}"

echo "Install ready in $target"
echo "  secrets/  owner-only secret files (left unchanged if they already existed)"
echo "  .env      non-secret settings; secrets referenced as *_FILE"
echo "Start with:"
echo "  ${root}/scripts/compose.sh --dir ${target} up -d"
echo "Then open PUBLIC_URL and create the first account with the install token from the app log."
