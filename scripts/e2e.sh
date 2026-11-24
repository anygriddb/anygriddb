#!/usr/bin/env bash
# An ephemeral Postgres for the Playwright parcours. The compose project
# is anygriddb-e2e, so this does not stop the developer's anygriddb stack.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

export POSTGRES_USER=anygriddb
# The database lasts one run, so its password does too.
POSTGRES_PASSWORD="$(
  node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))"
)"
export POSTGRES_PASSWORD
export POSTGRES_DB=anygriddb
AUTH_ENCRYPTION_KEY="$(
  node -e "process.stdout.write(Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'))"
)"
export AUTH_ENCRYPTION_KEY
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5433/${POSTGRES_DB}"
export PUBLIC_URL="https://localhost:4010"
# The browser is the TCP peer. Trusting loopback lets a journey set its
# own X-Forwarded-For, so it does not share the rate-limit bucket of the
# others. Production leaves ANYGRIDDB_TRUSTED_PROXIES empty.
export ANYGRIDDB_TRUSTED_PROXIES="127.0.0.1,::1"

compose=(docker compose -p anygriddb-e2e -f docker/compose.yml -f docker/compose.e2e.yml)

# The journeys count the accounts they make by name: a database left by
# the run before would hold theirs too. Each run starts on an empty one.
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans
}
trap cleanup EXIT

# The browser only, never its system packages: a CI runner already has
# the libraries, and fetching packages ties every run to a mirror.
pnpm --filter @anygriddb/web exec playwright install chromium

"${compose[@]}" up -d db mail --wait

# `pnpm test:e2e:coverage [playwright arguments]`: the journeys say what they
# ran, and a failed journey still leaves its report.
if [[ -n "${E2E_COVERAGE_DIR:-}" ]]; then
  mkdir -p "$E2E_COVERAGE_DIR"
  E2E_COVERAGE_DIR="$(cd "$E2E_COVERAGE_DIR" && pwd -P)"
  export E2E_COVERAGE_DIR
  rm -rf "$E2E_COVERAGE_DIR"/{client-raw,server-raw,pages,client,server}
  status=0
  pnpm --filter @anygriddb/web exec playwright test "$@" || status=$?
  pnpm --filter @anygriddb/web exec node e2e/coverage-report.mts "$E2E_COVERAGE_DIR"
  exit "$status"
fi

pnpm --filter @anygriddb/web exec playwright test
