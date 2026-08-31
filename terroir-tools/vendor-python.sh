#!/usr/bin/env bash
# Vendor terroir and its pure-Python dependencies into python/vendor so the
# extension renders templates without the user installing anything.
#
# Two portability problems this handles:
#   - terroir imports tomllib, which is stdlib only on Python 3.11+.
#     tomli is vendored and re-exported as tomllib for older interpreters.
#   - markupsafe and tomli ship compiled speedups built for one interpreter
#     and platform. They are deleted; both fall back to pure Python.
set -euo pipefail
cd "$(dirname "$0")/.."

VENDOR=python/vendor
rm -rf "$VENDOR"
python3 -m pip install --quiet --target "$VENDOR" terroir jinja2 pexpect tomli

find "$VENDOR" \( -name '*.so' -o -name '*.pyd' \) -delete
find "$VENDOR" -name '__pycache__' -type d -exec rm -rf {} +
rm -rf "$VENDOR/bin"

cat > "$VENDOR/tomllib.py" <<'SHIM'
"""Stand-in for the 3.11+ stdlib module, for older interpreters."""

from tomli import TOMLDecodeError, load, loads

__all__ = ['TOMLDecodeError', 'load', 'loads']
SHIM

echo "vendored into $VENDOR:"
ls "$VENDOR" | grep -v dist-info | sed 's/^/  /'
du -sh "$VENDOR"
