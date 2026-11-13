#!/usr/bin/env bash
# Checks the GitHub Actions workflows: actionlint (syntax, expressions,
# shell through shellcheck when it is installed) and zizmor (security:
# injections, credentials, permissions, pinned actions). Both MIT.
#
#   scripts/lint-workflows.sh
#
# Uses actionlint and zizmor from PATH when they are there; otherwise, on
# Linux x86-64 (CI), downloads the pinned releases and checks their SHA-256
# before running them. zizmor's online checks (actions with known flaws,
# commits that are not the action's) need GH_TOKEN; without it, they are
# skipped.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
ZIZMOR_VERSION=1.32.0
ZIZMOR_SHA256=bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b

tools="$(mktemp -d)"
trap 'rm -rf "$tools"' EXIT

fetch() {
  local url="$1" sha="$2" file
  file="$tools/$(basename "$url")"
  curl --fail --silent --show-error --location --output "$file" "$url"
  echo "$sha  $file" | sha256sum --check --quiet
  tar --extract --gzip --file "$file" --directory "$tools"
}

if ! command -v actionlint >/dev/null 2>&1 || ! command -v zizmor >/dev/null 2>&1; then
  if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
    echo "Install actionlint $ACTIONLINT_VERSION and zizmor $ZIZMOR_VERSION, or run this in CI." >&2
    exit 1
  fi
  fetch "https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT_VERSION/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
    "$ACTIONLINT_SHA256"
  fetch "https://github.com/zizmorcore/zizmor/releases/download/v$ZIZMOR_VERSION/zizmor-x86_64-unknown-linux-gnu.tar.gz" \
    "$ZIZMOR_SHA256"
  PATH="$tools:$PATH"
fi

actionlint
if [ -n "${GH_TOKEN:-}" ]; then
  zizmor --no-progress .github/workflows
else
  zizmor --no-progress --offline .github/workflows
fi
echo "The workflows are clean."
