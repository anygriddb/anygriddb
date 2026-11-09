#!/usr/bin/env bash
# Start the sample-database lab (Postgres, MySQL, MariaDB; SQL Server with --mssql).
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
if [[ "${1:-}" == "--mssql" ]] || [[ "${1:-}" == "--all" ]]; then
  PROFILE_ARGS+=(--profile mssql)
fi
docker compose "${PROFILE_ARGS[@]}" up -d
docker compose "${PROFILE_ARGS[@]}" ps
