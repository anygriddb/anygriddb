#!/usr/bin/env bash
# Start the sample-database lab (Postgres, MySQL, MariaDB; SQL Server with
# --mssql; Oracle Free with --oracle; both with --all).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LAB="$ROOT/docker/lab"
cd "$LAB"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Wrote $LAB/.env from .env.example"
fi
"$ROOT/scripts/lab/gen-certs.sh"
# Postgres refuses a world-readable key.
chmod 600 "$LAB/certs/server.key"
PROFILE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --mssql) PROFILE_ARGS+=(--profile mssql) ;;
    --oracle) PROFILE_ARGS+=(--profile oracle) ;;
    --all)
      PROFILE_ARGS+=(--profile mssql --profile oracle)
      ;;
  esac
done
docker compose "${PROFILE_ARGS[@]}" up -d
docker compose "${PROFILE_ARGS[@]}" ps
