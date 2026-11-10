#!/usr/bin/env bash
# Bring up the isolated VPS harness stack for one profile.
# Usage: scripts/vps/up.sh <profile> [--noisy] [--no-build] (profiles: common.sh)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

PROFILE=""
NOISY=0
BUILD=1
for arg in "$@"; do
  case "$arg" in
  --noisy) NOISY=1 ;;
  --no-build) BUILD=0 ;;
  --build) BUILD=1 ;;
  -h | --help)
    echo "Usage: $0 <profile> [--noisy] [--no-build]"
    usage_common
    exit 0
    ;;
  *)
    if is_profile "$arg"; then
      PROFILE="$arg"
    else
      echo "unknown argument: $arg" >&2
      exit 1
    fi
    ;;
  esac
done

if [[ -z "$PROFILE" ]]; then
  echo "Usage: $0 <profile> [--noisy] [--no-build]" >&2
  exit 1
fi

export VPS_PROFILE="$PROFILE"
ensure_env

PROFILE_ARGS=()
if [[ "$NOISY" -eq 1 ]]; then
  PROFILE_ARGS+=(--profile noisy)
fi

UP_ARGS=(up -d "${PROFILE_ARGS[@]}")
if [[ "$BUILD" -eq 1 ]]; then
  UP_ARGS+=(--build)
fi
# Credits can outlive compose --wait's patience; we poll ourselves.
UP_ARGS+=(--remove-orphans)

compose "${UP_ARGS[@]}"
apply_disk_limits "$PROFILE"
wait_healthy
compose ps
echo "VPS stack ready: $PUBLIC_URL_DEFAULT (profile=$PROFILE noisy=$NOISY)" >&2
