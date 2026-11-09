#!/usr/bin/env sh
# Validate a commit message file against Conventional Commits 1.0.0
# https://www.conventionalcommits.org/en/v1.0.0/
#
# Usage: validate-conventional-commit.sh <path-to-commit-msg-file>
set -eu

msg_file="${1:-}"
if [ -z "$msg_file" ] || [ ! -f "$msg_file" ]; then
  echo "usage: $0 <commit-msg-file>" >&2
  exit 2
fi

# Strip comment lines (# ...) that git may leave in the message file.
subject="$(
  grep -v '^#' "$msg_file" | sed '/./,$!d' | head -n 1 | tr -d '\r'
)"

if [ -z "$subject" ]; then
  echo "error: empty commit message" >&2
  exit 1
fi

# Allow automated merge / revert wrappers to skip the subject grammar.
# They still need a Signed-off-by trailer, checked below.
skip_subject=0
case "$subject" in
  "Merge "*|"Revert "*|"fixup! "*|"squash! "*)
    skip_subject=1
    ;;
esac

if [ "$skip_subject" -eq 0 ]; then

# <type>[optional scope][optional !]: <description>
# Types follow @commitlint/config-conventional (Angular convention).
# Description must be non-empty and must not end with a period.
if ! printf '%s\n' "$subject" | grep -Eq \
  '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-zA-Z0-9][a-zA-Z0-9._/-]*\))?(!)?: [^[:space:]].+$'
then
  cat >&2 <<'EOF'
error: commit message does not follow Conventional Commits 1.0.0

  <type>[optional scope][optional !]: <description>

  [optional body]

  [optional footer(s)]

Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

Examples:
  feat(api): add SQL Server connector
  fix(gui): restore filter hierarchy on import
  docs(arch): separate ops path from monolith app shape
  feat!: drop SQLite as a production meta store

  BREAKING CHANGE: production meta store is Postgres only.

Spec: https://www.conventionalcommits.org/en/v1.0.0/
EOF
  echo >&2
  echo "got: $subject" >&2
  exit 1
fi

# Prefer imperative, no trailing period on the subject (Angular / commitlint).
if printf '%s\n' "$subject" | grep -Eq '\.$'; then
  echo "error: subject must not end with a period" >&2
  echo "got: $subject" >&2
  exit 1
fi

# Same limit as commitlint header-max-length in commitlint.config.cjs.
# CI runs this script without installing commitlint.
if [ "${#subject}" -gt 100 ]; then
  echo "error: header must be at most 100 characters" >&2
  echo "got (${#subject}): $subject" >&2
  exit 1
fi
fi

# DCO: same trailer the Check DCO workflow requires on every pull request.
if ! grep -Eq '^Signed-off-by: .+ <.+>$' "$msg_file"; then
  cat >&2 <<'EOF'
error: missing Signed-off-by trailer

  git commit -s

The trailer must look like:
  Signed-off-by: Your Name <you@example.com>
EOF
  exit 1
fi

exit 0
