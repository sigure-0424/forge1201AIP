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
PROMPT_FILE="$JOB_DIR/gemini_prompt.txt"
STDOUT_LOG="$JOB_DIR/gemini.stdout.log"
STDERR_LOG="$JOB_DIR/gemini.stderr.log"
EXIT_CODE_FILE="$JOB_DIR/exit_code.txt"

if [ ! -f "$JOB_JSON" ]; then
  echo "[launch_gemini] missing $JOB_JSON" >&2
  exit 2
fi

python3 - <<'PYCODE' "$JOB_JSON" "$PROMPT_FILE"
from __future__ import annotations
import json
import sys
from pathlib import Path
job = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
prompt = f"TASK_ID: {job['task_id']}\nEXECUTION_MODE: {job['execution_mode']}\n\n"
prompt += "Operator request:\n"
prompt += (job.get('operator_request', '').strip() or '(not provided)') + "\n\n"
prompt += "Constraints:\n"
for item in job.get('constraints', []):
    prompt += f"- {item}\n"
prompt += "\nProhibited paths:\n"
for item in job.get('prohibited_paths', []):
    prompt += f"- {item}\n"
prompt += "\nDeliverables:\n"
for item in job.get('deliverables', []):
    prompt += f"- {item}\n"
prompt += "\nValidation commands:\n"
for item in job.get('validation_commands', []):
    prompt += f"- {item}\n"
prompt += "\nWrite logs into the assigned job directory and create needs_clarification.txt if you cannot proceed safely.\n"
Path(sys.argv[2]).write_text(prompt, encoding='utf-8')
PYCODE

if [ "$PRINT_ONLY" = "--print-only" ]; then
  cat "$PROMPT_FILE"
  exit 0
fi

if ! command -v gemini >/dev/null 2>&1; then
  echo "[launch_gemini] gemini not found in PATH." >&2
  exit 1
fi

cd "$ROOT"
set +e
gemini -y -p "$(cat "$PROMPT_FILE")" > >(tee "$STDOUT_LOG") 2> >(tee "$STDERR_LOG" >&2)
CODE=$?
set -e
printf '%s\n' "$CODE" > "$EXIT_CODE_FILE"
exit "$CODE"
