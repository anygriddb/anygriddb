#!/usr/bin/env bash
# Apply or clear tc netem on the app container's network namespace.
# Usage:
#   scripts/vps/netem.sh clear
#   scripts/vps/netem.sh latency <ms>           # e.g. 50 100 150
#   scripts/vps/netem.sh loss <percent>         # e.g. 0.5 1 2
#   scripts/vps/netem.sh rate <mbit>            # e.g. 2 10 200
#   scripts/vps/netem.sh combo --delay 100ms --loss 1% --rate 10mbit
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

APP="$(container_name app)"

if ! docker inspect "$APP" >/dev/null 2>&1; then
  echo "app container $APP is not running; start with scripts/vps/up.sh first" >&2
  exit 1
fi

run_tc() {
  # nicolaka/netshoot is common but not required: alpine + iproute2 is OSI.
  docker run --rm --network "container:${APP}" --cap-add NET_ADMIN \
    alpine:3.21 sh -c "apk add --no-cache iproute2 >/dev/null && $*"
}

clear_qdisc() {
  run_tc 'tc qdisc del dev eth0 root 2>/dev/null || true'
}

MODE="${1:-}"
shift || true

case "$MODE" in
clear)
  clear_qdisc
  echo "netem cleared on $APP" >&2
  ;;
latency)
  local_ms="${1:?latency ms required}"
  clear_qdisc
  run_tc "tc qdisc add dev eth0 root netem delay ${local_ms}ms"
  echo "netem delay ${local_ms}ms on $APP" >&2
  ;;
loss)
  pct="${1:?loss percent required}"
  clear_qdisc
  run_tc "tc qdisc add dev eth0 root netem loss ${pct}%"
  echo "netem loss ${pct}% on $APP" >&2
  ;;
rate)
  mbit="${1:?rate mbit required}"
  clear_qdisc
  # tbf shapes egress from the app (responses to clients).
  run_tc "tc qdisc add dev eth0 root tbf rate ${mbit}mbit burst 32kbit latency 400ms"
  echo "tbf rate ${mbit}mbit on $APP" >&2
  ;;
combo)
  clear_qdisc
  # Remaining args are passed to `tc qdisc add ... netem`.
  if [[ "$#" -eq 0 ]]; then
    echo "combo needs netem args, e.g. delay 100ms loss 1%" >&2
    exit 1
  fi
  run_tc "tc qdisc add dev eth0 root netem $*"
  echo "netem $* on $APP" >&2
  ;;
-h | --help | "")
  cat <<'EOF'
Usage:
  netem.sh clear
  netem.sh latency <ms>
  netem.sh loss <percent>
  netem.sh rate <mbit>
  netem.sh combo delay 100ms loss 1%
EOF
  [[ -n "$MODE" ]] || exit 1
  exit 0
  ;;
*)
  echo "unknown mode: $MODE" >&2
  exit 1
  ;;
esac
