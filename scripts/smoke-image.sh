#!/usr/bin/env bash
# Starts an AnyGridDB image the way an operator does (docker/compose.yml:
# its certificates, PostgreSQL over verified TLS, the migrations), then
# asks it what an operator would: /health, /ready, and its version, and
# reads what a first start wrote. A throwaway stack: its own project name,
# volumes, secrets, and port on the loopback, removed afterwards whatever
# happened.
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
# The new cluster takes its time, as on a slow disk. The image keeps a
# server on its socket alone meanwhile: AnyGridDB must wait for the one
# it can reach.
cat > "$work/compose.smoke.yml" <<EOF
configs:
  slow-first-start:
    content: |
      sleep 12
services:
  db:
    configs:
      - source: slow-first-start
        target: /docker-entrypoint-initdb.d/00-slow-first-start.sh
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

# AnyGridDB was started once: its database could be reached when it
# asked, and nothing else stopped it on the way.
restarts="$(docker inspect --format '{{.RestartCount}}' "$("${compose[@]}" ps --quiet app)")"
if [ "$restarts" != "0" ]; then
  echo "AnyGridDB was started $((restarts + 1)) times: it stopped on the way, as it does in front of a database it cannot reach yet." >&2
  exit 1
fi
curl --fail --silent --show-error --insecure "https://localhost:${port}/health"
echo
# PostgreSQL reached, the schema migrated.
curl --fail --silent --show-error --insecure "https://localhost:${port}/ready"
echo
# The license, and the licenses of the libraries the image holds, as the
# build wrote them and the app serves them (ADR 0096).
license="$(curl --fail --silent --show-error --insecure "https://localhost:${port}/license.txt")"
libraries="$(curl --fail --silent --show-error --insecure "https://localhost:${port}/third-party-licenses.txt")"
case "$license" in
  *"GNU AFFERO GENERAL PUBLIC LICENSE"*) ;;
  *)
    echo "The image does not serve its license." >&2
    exit 1
    ;;
esac
case "$libraries" in
  *" packages."*) ;;
  *)
    echo "The image does not serve the licenses of its libraries." >&2
    exit 1
    ;;
esac
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
# An automation's script runs in a process of its own, started from the
# bundle with Node's permission model (ADR 0099): the image must let it.
"${compose[@]}" exec -T app anygriddb scripts check
reported="$("${compose[@]}" exec -T app anygriddb version)"
echo "$reported"
if [ -n "${SMOKE_VERSION:-}" ] && ! grep -Fq "$SMOKE_VERSION" <<<"$reported"; then
  echo "The image reports another version than $SMOKE_VERSION." >&2
  exit 1
fi

# A first start leaves nothing for an operator to stop on: no warning and
# no error, in what PostgreSQL wrote or in what the instance did.
said="$("${compose[@]}" logs --no-color --no-log-prefix db 2>&1)"
if ! grep -Fq "00-slow-first-start.sh" <<<"$said"; then
  echo "The new cluster did not take its time: this start proved nothing about waiting for it." >&2
  exit 1
fi
if loud="$(grep -E '^initdb: warning|(WARNING|ERROR|FATAL|PANIC):' <<<"$said")"; then
  echo "PostgreSQL's log of a first start holds a warning or an error:" >&2
  echo "$loud" >&2
  exit 1
fi
said="$("${compose[@]}" logs --no-color --no-log-prefix certs app 2>&1)"
if loud="$(grep -E '^\{"level":(40|50|60),' <<<"$said")" ||
  loud="$(grep -v '^{' <<<"$said" | grep -iE 'warn|error|fail|fatal|deprecat')"; then
  echo "The instance's log of a first start holds a warning or an error:" >&2
  echo "$loud" >&2
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
