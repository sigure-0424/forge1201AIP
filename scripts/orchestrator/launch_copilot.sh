#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <job-dir> [--print-only]" >&2
  exit 2
fi

JOB_DIR="$1"
PRINT_ONLY="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
JOB_JSON="$JOB_DIR/job.json"
PROMPT_FILE="$JOB_DIR/copilot_prompt.txt"
STDOUT_LOG="$JOB_DIR/copilot.stdout.log"
STDERR_LOG="$JOB_DIR/copilot.stderr.log"
EXIT_CODE_FILE="$JOB_DIR/exit_code.txt"

if [ ! -f "$JOB_JSON" ]; then
  echo "[launch_copilot] missing $JOB_JSON" >&2
  exit 2
fi

python3 "$SCRIPT_DIR/render_prompt.py" "$JOB_JSON" "$PROMPT_FILE"

if [ "$PRINT_ONLY" = "--print-only" ]; then
  cat "$PROMPT_FILE"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[launch_copilot] gh CLI not found in PATH." >&2
  exit 1
fi

if ! gh copilot --help >/dev/null 2>&1; then
  echo "[launch_copilot] gh copilot extension not installed. Run: gh extension install github/gh-copilot" >&2
  exit 1
fi

cd "$ROOT"
set +e
gh copilot suggest -t shell "$(cat "$PROMPT_FILE")" > >(tee "$STDOUT_LOG") 2> >(tee "$STDERR_LOG" >&2)
CODE=$?
set -e
printf '%s\n' "$CODE" > "$EXIT_CODE_FILE"
exit "$CODE"
