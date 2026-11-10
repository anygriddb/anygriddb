# Shared helpers for the VPS constraint harness. Sourced by other scripts.
# shellcheck shell=bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCKER_DIR="$ROOT/docker"
ENV_FILE="$DOCKER_DIR/.env.vps"
PROJECT=anygriddb-vps
PUBLIC_URL_DEFAULT=https://localhost:3100
HOST_PORT=3100

VPS_PROFILES=(entry balanced credits)

# The instance's own authority, copied out of the app container: the
# harness verifies TLS like any client (ADR 0029), it never turns it off.
AUTHORITY="$ROOT/data/vps/authority.crt"

fetch_authority() {
  mkdir -p "$(dirname "$AUTHORITY")"
  docker cp "$(container_name app):/data/tls/authority.crt" "$AUTHORITY" \
    >/dev/null 2>&1
}

compose_files_for() {
  local profile="$1"
  echo -f "$DOCKER_DIR/compose.yml" \
    -f "$DOCKER_DIR/compose.vps.yml" \
    -f "$DOCKER_DIR/compose.vps-${profile}.yml"
}

compose() {
  local profile="${VPS_PROFILE:?VPS_PROFILE unset}"
  # shellcheck disable=SC2046
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
    $(compose_files_for "$profile") "$@"
}

ensure_env() {
  if [[ -f "$ENV_FILE" ]]; then
    return 0
  fi
  local key
  key="$(openssl rand -base64 32)"
  cat >"$ENV_FILE" <<EOF
POSTGRES_USER=anygriddb
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
POSTGRES_DB=anygriddb
AUTH_ENCRYPTION_KEY=$key
PUBLIC_URL=$PUBLIC_URL_DEFAULT
ADMIN_EMAILS=vps-admin@example.com
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE" >&2
}

container_name() {
  local service="$1"
  echo "${PROJECT}-${service}-1"
}

# Whole-disk major:minor under Docker's data root (cgroup io.max rejects partitions).
root_block_device() {
  local target source parent node maj hex_maj hex_min
  target="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  [[ -e "$target" ]] || target=/
  source="$(findmnt -n -o SOURCE --target "$target" 2>/dev/null || true)"
  parent=""
  if [[ -n "$source" && -e "$source" ]]; then
    parent="$(lsblk -no PKNAME "$source" 2>/dev/null | head -n1 | tr -d '[:space:]')"
  fi
  if [[ -n "$parent" && -e "/dev/$parent" ]]; then
    node="/dev/$parent"
  elif [[ -n "$source" && -e "$source" ]]; then
    node="$source"
  else
    echo "259:0"
    return 0
  fi
  hex_maj="$(stat -c '%t' "$node")"
  hex_min="$(stat -c '%T' "$node")"
  printf '%d:%d\n' "0x${hex_maj}" "0x${hex_min}"
}

# cgroup v2 io.max path for a running container (Docker Engine on systemd).
cgroup_io_max() {
  local id
  id="$(docker inspect -f '{{.Id}}' "$1")"
  echo "/sys/fs/cgroup/system.slice/docker-${id}.scope/io.max"
}

# Apply disk IOPS / bandwidth caps via cgroup v2 (docker update has no
# --device-*-iops on this Engine). Requires passwordless sudo for the write.
apply_disk_limits() {
  local profile="$1"
  local dev read_iops write_iops read_bps write_bps
  dev="$(root_block_device)"
  case "$profile" in
  entry | credits)
    read_iops=10000
    write_iops=10000
    read_bps=$((250 * 1024 * 1024))
    write_bps=$((250 * 1024 * 1024))
    ;;
  balanced)
    read_iops=50000
    write_iops=50000
    read_bps=$((1200 * 1024 * 1024))
    write_bps=$((1200 * 1024 * 1024))
    ;;
  *)
    echo "unknown profile: $profile" >&2
    return 1
    ;;
  esac
  local service name path
  for service in app db; do
    name="$(container_name "$service")"
    path="$(cgroup_io_max "$name")"
    if [[ ! -e "$path" ]]; then
      echo "missing cgroup io.max for $name ($path)" >&2
      return 1
    fi
    if ! printf '%s riops=%s wiops=%s rbps=%s wbps=%s\n' \
      "$dev" "$read_iops" "$write_iops" "$read_bps" "$write_bps" |
      sudo tee "$path" >/dev/null; then
      echo "warning: could not set io.max on $name (sudo / device $dev)" >&2
      return 0
    fi
  done
  echo "disk limits on $dev (r/w iops=$read_iops bps=$write_bps) for app+db" >&2
}

wait_healthy() {
  # Credits: health CLI alone can take >10s; allow several minutes.
  local name tries=90
  name="$(container_name app)"
  local i status
  for i in $(seq 1 "$tries"); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)"
    if [[ "$status" == "healthy" ]] && fetch_authority; then
      return 0
    fi
    # Fallback: HTTP /health may succeed while the CLI healthcheck is still slow.
    if fetch_authority &&
      curl -sf --cacert "$AUTHORITY" --max-time 5 \
        "https://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
      echo "app HTTP /health ok (compose health=$status)" >&2
      return 0
    fi
    sleep 2
  done
  echo "app container not healthy after ${tries} tries (last=$status)" >&2
  docker ps -a --filter "name=${PROJECT}" >&2 || true
  return 1
}

usage_common() {
  cat <<'EOF'
Profiles: entry | balanced | credits
Env:      docker/.env.vps (created on first up)
URL:      https://localhost:3100  (project anygriddb-vps)
EOF
}
