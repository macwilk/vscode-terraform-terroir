#!/usr/bin/env bash
# Show how far this fork has drifted from upstream in files upstream owns.
# Everything terroir adds lives in paths upstream does not have, so the only
# numbers that matter are the ones this prints.
set -euo pipefail

git fetch upstream main --depth=1 >/dev/null 2>&1 || true

echo "== files upstream owns that we touched =="
git diff --stat upstream/main -- . \
  ':!src/terroir' ':!python' ':!syntaxes-custom' ':!terroir-tools' ':!TERROIR.md'

echo
echo "== the diff itself =="
git diff upstream/main -- . \
  ':!src/terroir' ':!python' ':!syntaxes-custom' ':!terroir-tools' ':!TERROIR.md'
