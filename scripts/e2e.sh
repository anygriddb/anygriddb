#!/usr/bin/env bash
# An ephemeral Postgres for the Playwright parcours. The compose project
# is anygriddb-e2e, so this does not stop the developer's anygriddb stack.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

export POSTGRES_USER=anygriddb
export POSTGRES_PASSWORD=anygriddb
export POSTGRES_DB=anygriddb
export AUTH_ENCRYPTION_KEY="$(
  node -e "process.stdout.write(Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'))"
)"
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5433/${POSTGRES_DB}"
export PUBLIC_URL="https://localhost:4010"
# The browser is the TCP peer. Trusting loopback lets a journey set its
# own X-Forwarded-For, so it does not share the rate-limit bucket of the
# others. Production leaves ANYGRIDDB_TRUSTED_PROXIES empty.
export ANYGRIDDB_TRUSTED_PROXIES="127.0.0.1,::1"

compose=(docker compose -p anygriddb-e2e -f docker/compose.yml -f docker/compose.e2e.yml)

cleanup() {
  "${compose[@]}" down --remove-orphans
}
trap cleanup EXIT

# The browser only, never its system packages: a CI runner already has
# the libraries, and fetching packages ties every run to a mirror.
pnpm --filter @anygriddb/web exec playwright install chromium

"${compose[@]}" up -d db mail --wait
pnpm --filter @anygriddb/web exec playwright test
