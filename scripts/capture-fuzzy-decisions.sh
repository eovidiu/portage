#!/usr/bin/env bash
# Capture `event: "fuzzy_decision"` log lines from `wrangler tail` for a
# fixed duration. Useful for auditing a single cron fire without leaving
# `wrangler tail` running indefinitely.
#
# Usage:
#   bash scripts/capture-fuzzy-decisions.sh [duration_seconds]
#
# Default duration is 480s (8 minutes) — enough to span a cron + log flush.
# Output goes to .harness/diagnostics/fuzzy-decisions-<UTC_timestamp>.jsonl
# (gitignored via .harness/diagnostics/ if you prefer — currently tracked).
#
# The script writes ONE JSON object per line (`fuzzy_decision` events only,
# filtered by jq), so you can paste the file path back to Claude for
# aggregation.

set -euo pipefail

DURATION="${1:-480}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT}/.harness/diagnostics"
mkdir -p "$OUT_DIR"

TS="$(date -u +'%Y-%m-%dT%H-%M-%SZ')"
OUT_FILE="${OUT_DIR}/fuzzy-decisions-${TS}.jsonl"

echo "Capturing fuzzy_decision events for ${DURATION}s → ${OUT_FILE}"
echo "Ctrl-C to abort early; the file will still contain whatever was captured."

# `timeout` ships with coreutils on Linux; macOS ships `gtimeout` via brew or
# you can `brew install coreutils`. Fallback to a manual subshell + kill if
# `timeout` is missing.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout "$DURATION")
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(gtimeout "$DURATION")
else
  TIMEOUT_CMD=()
fi

if [ ${#TIMEOUT_CMD[@]} -eq 0 ]; then
  # No `timeout` available — run wrangler tail in the background and kill
  # it after $DURATION. `wrangler tail` already streams to stdout; we pipe
  # into jq and tee to the output file.
  (
    npx wrangler tail --format json &
    WP=$!
    (sleep "$DURATION" && kill "$WP" 2>/dev/null) &
    wait "$WP" 2>/dev/null || true
  ) | jq -c 'select(.event == "fuzzy_decision")' | tee "$OUT_FILE"
else
  "${TIMEOUT_CMD[@]}" npx wrangler tail --format json \
    | jq -c 'select(.event == "fuzzy_decision")' \
    | tee "$OUT_FILE"
fi

echo ""
echo "Done. Captured $(wc -l < "$OUT_FILE" | tr -d ' ') fuzzy_decision lines."
echo "Output file: ${OUT_FILE}"
