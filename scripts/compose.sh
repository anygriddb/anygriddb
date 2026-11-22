#!/usr/bin/env bash
# `docker compose` for an install that keeps its secrets in files
# (scripts/install.sh): it reads them for Compose to fill compose.yml in,
# which still refuses to start without them, and adds compose.secrets.yml,
# which mounts the files and leaves the variables empty in the containers.
#
#   scripts/compose.sh up -d
#   scripts/compose.sh --dir /srv/anygriddb -f compose.release.yml \
#     --env-file image-pin.env up -d
#
# Options before the command go to `docker compose`, after compose.yml and
# compose.secrets.yml. Never prints a secret.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$root/docker"
if [ "${1:-}" = "--dir" ]; then
  target="$(cd "${2:?usage: scripts/compose.sh --dir <folder> ...}" && pwd)"
  shift 2
fi
cd "$target"

# Named first, .env stays read when the options name another file too.
env_files=()
if [ -f .env ]; then env_files=(--env-file "$target/.env"); fi
# shellcheck source=scripts/env-file.sh
. "$root/scripts/env-file.sh"
read_env_file "$target/.env" POSTGRES_PASSWORD AUTH_ENCRYPTION_KEY \
  POSTGRES_PASSWORD_FILE AUTH_ENCRYPTION_KEY_FILE
# shellcheck source=scripts/secret-files.sh
. "$root/scripts/secret-files.sh"
load_secret_files "$target"

exec docker compose ${env_files[@]+"${env_files[@]}"} \
  -f compose.yml -f compose.secrets.yml "$@"
