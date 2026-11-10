#!/usr/bin/env bash
# Tear down the isolated VPS harness. Usage: scripts/vps/down.sh [--volumes]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

WITH_VOLUMES=0
for arg in "$@"; do
  case "$arg" in
  --volumes | -v) WITH_VOLUMES=1 ;;
  -h | --help)
    echo "Usage: $0 [--volumes]"
    exit 0
    ;;
  *)
    echo "unknown argument: $arg" >&2
    exit 1
    ;;
  esac
done

# Profile file is required by compose(); any profile overlay works for down.
export VPS_PROFILE="${VPS_PROFILE:-entry}"
ensure_env

ARGS=(--profile noisy down --remove-orphans)
if [[ "$WITH_VOLUMES" -eq 1 ]]; then
  ARGS+=(-v)
fi
compose "${ARGS[@]}"
echo "VPS stack stopped (volumes=$WITH_VOLUMES)" >&2
