#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
mkdir -p "$ROOT/tmp/orchestrator/jobs" "$ROOT/tmp/orchestrator/archive" "$ROOT/tmp/locks"

find "$ROOT/tmp/locks" -maxdepth 1 -type f -name '*.lock' -mmin +240 -print -delete || true
find "$ROOT/tmp/orchestrator/jobs" -maxdepth 1 -type d -name 'TASK-*' -empty -mmin +240 -print -exec rmdir {} + || true

echo "[recover_runtime] runtime directories checked"
