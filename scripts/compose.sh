#!/usr/bin/env bash
# Compose with the secrets overlay. The base file still requires
# POSTGRES_PASSWORD and AUTH_ENCRYPTION_KEY, so an install that forgets
# them fails closed. install.sh keeps those values in secret files; this
# reads the files only so Compose can interpolate, and compose.secrets.yml
# then mounts the files and leaves the variables empty in the containers.
#
#   ./scripts/compose.sh up -d
#   ./scripts/compose.sh --dir /path/to/docker config
#
# Never prints a secret.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$root/docker"
if [ "${1:-}" = "--dir" ]; then
  target="$(cd "$2" && pwd)"
  shift 2
fi

read_secret() {
  tr -d '\r\n' <"$1"
}

if [ -z "${POSTGRES_PASSWORD:-}" ] && [ -f "$target/secrets/postgres_password" ]; then
  POSTGRES_PASSWORD="$(read_secret "$target/secrets/postgres_password")"
  export POSTGRES_PASSWORD
fi
if [ -z "${AUTH_ENCRYPTION_KEY:-}" ] && [ -f "$target/secrets/auth_encryption_key" ]; then
  AUTH_ENCRYPTION_KEY="$(read_secret "$target/secrets/auth_encryption_key")"
  export AUTH_ENCRYPTION_KEY
fi

cd "$target"
exec docker compose -f compose.yml -f compose.secrets.yml "$@"
