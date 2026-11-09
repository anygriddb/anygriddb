#!/usr/bin/env bash
# Stop the sample-database lab. Pass --volumes to wipe data.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/docker/lab"
ARGS=(--profile mssql down)
if [[ "${1:-}" == "--volumes" ]]; then
  ARGS+=(--volumes)
fi
docker compose "${ARGS[@]}"
