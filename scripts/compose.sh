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

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
# shellcheck source=scripts/secret-files.sh
. "$root/scripts/secret-files.sh"
load_secret_files "$target"

exec docker compose -f compose.yml -f compose.secrets.yml "$@"
