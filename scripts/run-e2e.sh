#!/usr/bin/env bash
# Run the e2e test suite against a live wrangler dev process.
#
# Usage: bash scripts/run-e2e.sh [vitest args]
#
# The script:
#   1. Starts wrangler dev on port 8787
#   2. Waits up to 30 s for the /healthz endpoint to respond
#   3. Runs vitest with vitest.e2e.config.ts
#   4. Kills wrangler dev (SIGTERM, then SIGKILL if needed)
#   5. Exits with the vitest exit code
#
# NOTE: vitest manages wrangler lifecycle via beforeAll/afterAll hooks in harness.ts.
# This script is the thin orchestration wrapper used by `npm run test:e2e`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WRANGLER_PORT=8787
STARTUP_TIMEOUT=30

cd "$PROJECT_ROOT"

echo "[run-e2e] Running e2e suite (vitest.e2e.config.ts)"

# Run vitest with the e2e config. The harness starts/stops wrangler dev internally
# via Node child_process so we get proper lifecycle control within the test runner.
node node_modules/.bin/vitest run --config vitest.e2e.config.ts "$@"
EXIT_CODE=$?

echo "[run-e2e] e2e suite exited with code $EXIT_CODE"
exit $EXIT_CODE
