#!/usr/bin/env bash
# Checks what the compiler and ESLint do not read: every shell script
# (ShellCheck), the image's recipe (Hadolint), and the whole git history for
# secrets (Gitleaks). A value known to be made up is listed by its
# fingerprint in `.gitleaksignore`, so that the same file can still be
# refused for a new one.
#
#   scripts/lint-security.sh
#
# Uses the three tools from PATH when they are there; otherwise, on Linux
# x86-64 (CI), downloads the pinned releases and checks their SHA-256 before
# running them.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

SHELLCHECK_VERSION=0.11.0
SHELLCHECK_SHA256=8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198
HADOLINT_VERSION=2.15.1
HADOLINT_SHA256=c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb

tools="$(mktemp -d)"
trap 'rm -rf "$tools"' EXIT

fetch() {
  local url="$1" sha="$2" file
  file="$tools/$(basename "$url")"
  curl --fail --silent --show-error --location --output "$file" "$url"
  echo "$sha  $file" | sha256sum --check --quiet
}

if ! command -v shellcheck >/dev/null 2>&1 ||
  ! command -v hadolint >/dev/null 2>&1 ||
  ! command -v gitleaks >/dev/null 2>&1; then
  if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
    echo "Install ShellCheck $SHELLCHECK_VERSION, Hadolint $HADOLINT_VERSION and Gitleaks $GITLEAKS_VERSION, or run this in CI." >&2
    exit 1
  fi
  fetch "https://github.com/koalaman/shellcheck/releases/download/v$SHELLCHECK_VERSION/shellcheck-v$SHELLCHECK_VERSION.linux.x86_64.tar.xz" \
    "$SHELLCHECK_SHA256"
  tar --extract --xz --strip-components=1 \
    --file "$tools/shellcheck-v$SHELLCHECK_VERSION.linux.x86_64.tar.xz" \
    --directory "$tools" "shellcheck-v$SHELLCHECK_VERSION/shellcheck"
  fetch "https://github.com/hadolint/hadolint/releases/download/v$HADOLINT_VERSION/hadolint-linux-x86_64" \
    "$HADOLINT_SHA256"
  install -m 755 "$tools/hadolint-linux-x86_64" "$tools/hadolint"
  fetch "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    "$GITLEAKS_SHA256"
  tar --extract --gzip --file "$tools/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    --directory "$tools" gitleaks
  PATH="$tools:$PATH"
fi

mapfile -t scripts < <(git ls-files '*.sh')
shellcheck --external-sources --source-path=SCRIPTDIR "${scripts[@]}"
hadolint docker/Dockerfile
gitleaks git --no-banner --redact --log-level=warn .
echo "Scripts, image recipe and history are clean (${#scripts[@]} scripts)."
