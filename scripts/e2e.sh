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

compose=(docker compose -p anygriddb-e2e -f docker/compose.yml -f docker/compose.e2e.yml)

cleanup() {
  "${compose[@]}" down --remove-orphans
}
trap cleanup EXIT

if [ "${CI:-}" = "true" ]; then
  pnpm --filter @anygriddb/web exec playwright install --with-deps chromium
else
  pnpm --filter @anygriddb/web exec playwright install chromium
fi

"${compose[@]}" up -d db --wait
pnpm --filter @anygriddb/web exec playwright test
