#!/usr/bin/env bash
# First publish of AnyGridDB — run when ready.
set -euo pipefail
cd "$(dirname "$0")/.."
git remote get-url origin | grep -q 'anygriddb/anygriddb' \
  || { echo "origin must be git@github.com:anygriddb/anygriddb.git"; exit 1; }
echo "Pushing main -> origin (anygriddb/anygriddb) ..."
git push -u origin main
echo "Done: https://github.com/anygriddb/anygriddb"
