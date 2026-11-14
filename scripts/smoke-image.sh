#!/usr/bin/env bash
# Starts an AnyGridDB image the way an operator does (docker/compose.yml:
# its certificates, PostgreSQL over verified TLS, the migrations), then
# asks it what an operator would: /health, /ready, and its version. A
# throwaway stack: its own project name, volumes, secrets, and port on the
# loopback, removed afterwards whatever happened.
#
#   scripts/smoke-image.sh                        # the image anygriddb:local
#   SMOKE_PORT=3443 scripts/smoke-image.sh        # another port
#   SMOKE_VERSION=0.2.0 scripts/smoke-image.sh    # the version it must report
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${SMOKE_PORT:-3443}"
work="$(mktemp -d)"
project="anygriddb-smoke-$$"

cat > "$work/smoke.env" <<EOF
POSTGRES_USER=anygriddb
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=anygriddb
AUTH_ENCRYPTION_KEY=$(openssl rand -base64 32)
PUBLIC_URL=https://localhost:${port}
EOF
cat > "$work/compose.smoke.yml" <<EOF
services:
  app:
    ports: !override
      - "127.0.0.1:${port}:4000"
EOF

compose=(docker compose -p "$project" --env-file "$work/smoke.env"
  -f "$root/docker/compose.yml" -f "$work/compose.smoke.yml")

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "The image did not start as it should: what the stack said." >&2
    "${compose[@]}" ps --all >&2 || true
    "${compose[@]}" logs --no-color --tail 80 certs db app >&2 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

"${compose[@]}" up --detach --no-build --wait --wait-timeout 240

curl --fail --silent --show-error --insecure "https://localhost:${port}/health"
echo
# PostgreSQL reached, the schema migrated.
curl --fail --silent --show-error --insecure "https://localhost:${port}/ready"
echo
# AnyGridDB's role owns its database and is no superuser (ADR 0003).
role="$("${compose[@]}" exec -T db psql -U anygriddb -d anygriddb -tAc \
  "select rolsuper::text || ' ' || pg_get_userbyid(datdba) from pg_roles, pg_database where rolname = current_user and datname = current_database()")"
if [ "$role" != "false anygriddb" ]; then
  echo "AnyGridDB's PostgreSQL role is a superuser, or does not own its database: $role" >&2
  exit 1
fi
# Nothing is written to the image, and what comes in or goes out (an
# import, an export, a snapshot) is written whole to /tmp on its way: it
# must take a large file, on disk rather than in memory.
"${compose[@]}" exec -T app sh -c '
  set -e
  if touch /written 2>/dev/null; then
    echo "The image can be written to." >&2
    exit 1
  fi
  if grep -q " /tmp tmpfs " /proc/mounts; then
    echo "/tmp is kept in memory." >&2
    exit 1
  fi
  dd if=/dev/zero of=/tmp/large bs=1M count=128 2>/dev/null
  rm /tmp/large
'
reported="$("${compose[@]}" exec -T app anygriddb version)"
echo "$reported"
if [ -n "${SMOKE_VERSION:-}" ] && ! grep -Fq "$SMOKE_VERSION" <<<"$reported"; then
  echo "The image reports another version than $SMOKE_VERSION." >&2
  exit 1
fi

# A stack that ran PostgreSQL 17 keeps its data in `postgres_data`. This
# one must stop in front of it and say how to move it, never start on an
# empty database. Tried on a folder closed as PostgreSQL closes its own:
# to its account alone.
"${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1
docker volume create --label "com.docker.compose.project=$project" \
  --label com.docker.compose.volume=postgres_data "${project}_postgres_data" >/dev/null
docker run --rm --network none --volume "${project}_postgres_data:/old" \
  --entrypoint sh postgres:18 -c \
  'echo 17 > /old/PG_VERSION && chown -R postgres:postgres /old && chmod 700 /old'
if said="$("${compose[@]}" run --rm --no-deps postgres-upgrade-check 2>&1)"; then
  echo "The stack would start on an empty database in front of PostgreSQL 17 data." >&2
  exit 1
fi
if ! grep -Fq "scripts/upgrade-postgres.sh" <<<"$said"; then
  echo "The check stopped without saying how to move the data: $said" >&2
  exit 1
fi
# And the script that moves it is let through.
ANYGRIDDB_PG_UPGRADE=1 "${compose[@]}" run --rm --no-deps postgres-upgrade-check

echo "The image started, reached PostgreSQL, and answers."
