#!/usr/bin/env bash
# Builds AnyGridDB's image from this checkout, labelled with what it is
# (ADR 0048): the version in package.json, the commit, and the date. The
# app reports the same in Administration > Health and `anygriddb version`.
#
#   scripts/build-image.sh                      # the stack in docker/ (compose.yml)
#   scripts/build-image.sh -f compose.managed.yml
#
# Options go to `docker compose` as they are; settings come from
# docker/.env, or the file ENV_FILE names. Then `docker compose up -d`
# starts what it built. It warns, without stopping, when the checkout is
# not a release: changes not committed, or HEAD is not the tag v<version>.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

warn() { printf 'warning: %s\n' "$1" >&2; }

version="$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' package.json | head -n 1)"
: "${version:?no version in package.json}"

commit="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -z "$commit" ]; then
  warn "not a git checkout: the image will not record its commit."
else
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    warn "changes not committed: the image is not exactly commit ${commit:0:12}."
  fi
  if ! git tag --points-at HEAD | grep -Fxq "v$version"; then
    warn "HEAD is not the release tag v$version: this is a development build."
  fi
fi

export ANYGRIDDB_VERSION="$version"
export ANYGRIDDB_COMMIT="$commit"
ANYGRIDDB_CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export ANYGRIDDB_CREATED

cd "$root/docker"
env_file="${ENV_FILE:-.env}"
args=("$@")
if [ ${#args[@]} -eq 0 ]; then args=(-f compose.yml); fi
compose=(docker compose "${args[@]}")
if [ -f "$env_file" ]; then compose=(docker compose --env-file "$env_file" "${args[@]}"); fi

"${compose[@]}" build
printf 'Built AnyGridDB %s (commit %s). Start it: docker compose up -d\n' \
  "$version" "${commit:0:12}"
