#!/usr/bin/env bash
# Runs Turborepo tasks in CI (.github/workflows/ci.yml).
#
#   scripts/ci-turbo.sh lint typecheck test
#
# On a pull request whose files all lie inside a package or are
# documentation, only the packages it changes and those that depend on
# them. A file anywhere else (the workflows, scripts/, docker/, the root's
# configuration) can change how any task runs while Turborepo counts it in
# no package: then every task runs, as on main.
set -euo pipefail

if [ "${EVENT_NAME:-}" = "pull_request" ]; then
  base="origin/${BASE_REF:?BASE_REF is required on a pull request}"
  changed="$(git diff --name-only "$base...HEAD")"
  outside="$(grep -vE '^(apps|packages|docs)/|\.md$' <<<"$changed" || true)"
  if [ -z "$outside" ]; then
    TURBO_SCM_BASE="$base" exec pnpm exec turbo run "$@" --affected
  fi
  echo "Every task runs: files outside the packages changed."
  head -n 10 <<<"$outside"
fi
exec pnpm exec turbo run "$@"
