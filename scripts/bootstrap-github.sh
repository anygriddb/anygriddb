#!/usr/bin/env bash
# Create GitHub org repo anygriddb/anygriddb (empty) — does NOT push local history.
set -euo pipefail
ORG=anygriddb
REPO=anygriddb

if ! gh api "orgs/${ORG}" --jq .login >/dev/null 2>&1; then
  echo "Organization '${ORG}' does not exist yet."
  echo "Create it here (free plan), then re-run this script:"
  echo "  https://github.com/account/organizations/new?plan=free"
  echo "  Suggested: Organization name = anygriddb, Contact email = yours"
  exit 1
fi

if gh repo view "${ORG}/${REPO}" >/dev/null 2>&1; then
  echo "Repo ${ORG}/${REPO} already exists."
else
  echo "Creating empty public repo ${ORG}/${REPO} (no README, no push)..."
  gh repo create "${ORG}/${REPO}" \
    --public \
    --description "AnyGridDB — open-source spreadsheet databases. AGPL-3.0. No paid feature locks." \
    --disable-wiki
fi

cd "$(dirname "$0")/.."
git remote remove origin 2>/dev/null || true
git remote add origin "git@github.com:${ORG}/${REPO}.git"
git remote -v
echo
echo "Ready. When you want to publish history:"
echo "  ./scripts/push-first.sh"
echo "  # or: git push -u origin main"
