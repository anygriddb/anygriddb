#!/usr/bin/env bash
# Run the VPS constraint matrix against an isolated stack.
# Usage: scripts/vps/run.sh [--profiles entry,balanced,credits] [--seconds 20]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

PROFILES=("${VPS_PROFILES[@]}")
SECONDS_LOAD=20
CONCURRENCY=4
API_RPS=8
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
  --profiles)
    IFS=',' read -r -a PROFILES <<<"$2"
    for profile in "${PROFILES[@]}"; do
      is_profile "$profile" || {
        echo "unknown profile: $profile (one of: ${VPS_PROFILES[*]})" >&2
        exit 1
      }
    done
    shift 2
    ;;
  --seconds)
    SECONDS_LOAD="$2"
    shift 2
    ;;
  --concurrency)
    CONCURRENCY="$2"
    shift 2
    ;;
  --api-rps)
    API_RPS="$2"
    shift 2
    ;;
  --keep)
    KEEP=1
    shift
    ;;
  -h | --help)
    cat <<'EOF'
Usage: run.sh [--profiles entry,balanced,credits] [--seconds 20] [--concurrency 6] [--keep]
Runs baseline, noisy-neighbor, net latency/loss/throttle, and a short
RAM-pressure probe per profile. Results: data/vps-results/<stamp>/
EOF
    exit 0
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 1
    ;;
  esac
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$ROOT/data/vps-results/$STAMP"
mkdir -p "$OUT_DIR"
BASE_URL="$PUBLIC_URL_DEFAULT"

echo "results → $OUT_DIR" >&2

collect_runtime() {
  local profile="$1" case_name="$2"
  local app db
  app="$(container_name app)"
  db="$(container_name db)"
  local stats oom restarts
  stats="$(docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' "$app" "$db" 2>/dev/null || true)"
  oom="$(docker inspect --format '{{.State.OOMKilled}}' "$app" "$db" 2>/dev/null | paste -sd, - || echo unknown)"
  restarts="$(docker inspect --format '{{.RestartCount}}' "$app" 2>/dev/null || echo 0)"
  python3 - "$OUT_DIR/${profile}-${case_name}.runtime.json" <<PY
import json, sys
path = sys.argv[1]
json.dump({
  "profile": "$profile",
  "case": "$case_name",
  "stats": """$stats""",
  "oomKilled": """$oom""",
  "restarts": int("""$restarts""" or 0),
  "oomKills": 1 if "true" in """$oom""".lower() else 0,
}, open(path, "w"), indent=2)
print(path)
PY
}

merge_runtime() {
  local load_json="$1" runtime_json="$2"
  python3 - "$load_json" "$runtime_json" <<'PY'
import json, sys
load_path, runtime_path = sys.argv[1], sys.argv[2]
doc = json.load(open(load_path))
runtime = json.load(open(runtime_path))
doc["runtime"] = runtime
doc["case"] = runtime["profile"] + "/" + runtime["case"]
json.dump(doc, open(load_path, "w"), indent=2)
print(load_path)
PY
}

run_case() {
  local profile="$1" case_name="$2"
  local out="$OUT_DIR/${profile}-${case_name}.json"
  echo "==> $profile / $case_name" >&2
  local load_rc=0
  fetch_authority || echo "warning: no authority copied from the app" >&2
  NODE_EXTRA_CA_CERTS="$AUTHORITY" node "$SCRIPT_DIR/load.mjs" \
    --base "$BASE_URL" \
    --seconds "$SECONDS_LOAD" \
    --concurrency "$CONCURRENCY" \
    --api-rps "$API_RPS" \
    --out "$out" || load_rc=$?
  if [[ ! -f "$out" ]]; then
    printf '%s\n' "{\"started\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"baseUrl\":\"$BASE_URL\",\"load\":null,\"error\":\"load_failed\",\"exitCode\":$load_rc}" >"$out"
  fi
  collect_runtime "$profile" "$case_name"
  merge_runtime "$out" "$OUT_DIR/${profile}-${case_name}.runtime.json"
  rm -f "$OUT_DIR/${profile}-${case_name}.runtime.json"
  return "$load_rc"
}

ram_pressure() {
  local profile="$1"
  local app
  app="$(container_name app)"
  # Temporarily tighten memory to provoke reclaim / OOM under load.
  docker update --memory 256m --memory-swap 256m "$app" >/dev/null || true
  run_case "$profile" "ram-pressure" || true
  # Back to the profile's own envelope.
  profile_settings "$profile"
  docker update --memory "$VPS_APP_MEM" --memory-swap "$VPS_APP_MEMSWAP" \
    "$app" >/dev/null || true
  "$SCRIPT_DIR/netem.sh" clear >/dev/null 2>&1 || true
  wait_healthy || true
}

for profile in "${PROFILES[@]}"; do
  echo "---- profile $profile ----" >&2
  "$SCRIPT_DIR/down.sh" --volumes >/dev/null 2>&1 || true
  "$SCRIPT_DIR/up.sh" "$profile"

  run_case "$profile" "baseline"

  echo "noisy neighbor" >&2
  export VPS_PROFILE="$profile"
  ensure_env
  compose --profile noisy up -d neighbor
  sleep 2
  run_case "$profile" "noisy"
  compose --profile noisy stop neighbor >/dev/null 2>&1 || true

  "$SCRIPT_DIR/netem.sh" latency 100
  run_case "$profile" "net-latency"
  "$SCRIPT_DIR/netem.sh" clear

  "$SCRIPT_DIR/netem.sh" loss 1
  run_case "$profile" "net-loss"
  "$SCRIPT_DIR/netem.sh" clear

  "$SCRIPT_DIR/netem.sh" rate 10
  run_case "$profile" "net-throttle"
  "$SCRIPT_DIR/netem.sh" clear

  ram_pressure "$profile"
done

if [[ "$KEEP" -ne 1 ]]; then
  "$SCRIPT_DIR/down.sh" --volumes >/dev/null 2>&1 || true
fi

echo "---- summary ----" >&2
node "$SCRIPT_DIR/report.mjs" "$OUT_DIR" | tee "$OUT_DIR/summary.txt"
echo "done: $OUT_DIR" >&2
