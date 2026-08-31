#!/usr/bin/env bash
# Unit tests for the terroir modules. The upstream test runner only globs
# integration suites under src/test/integration, so these run directly rather
# than reshaping the fork to fit.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run compile:tests
npx mocha --ui tdd "out/terroir/*.test.js"
