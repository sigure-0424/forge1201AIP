#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <job-dir>" >&2
  exit 2
fi

JOB_DIR="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
JOB_JSON="$JOB_DIR/job.json"
LOG_FILE="$JOB_DIR/validator.log"
JSON_FILE="$JOB_DIR/validator.json"
COMMANDS_FILE="$JOB_DIR/.validation_commands.txt"

if [ ! -f "$JOB_JSON" ]; then
  echo "[validate_task] missing $JOB_JSON" >&2
  exit 2
fi

python3 - <<'PYCODE' "$JOB_JSON" "$COMMANDS_FILE"
from __future__ import annotations
import json
import sys
from pathlib import Path
job = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
commands = job.get('validation_commands', [])
Path(sys.argv[2]).write_text('\n'.join(commands) + ('\n' if commands else ''), encoding='utf-8')
PYCODE

if [ ! -s "$COMMANDS_FILE" ]; then
  python3 - <<'PYCODE' "$JSON_FILE"
from __future__ import annotations
import json
import sys
from pathlib import Path
payload = {
    'passed': False,
    'reason': 'validation_commands is empty',
    'commands': [],
}
Path(sys.argv[1]).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PYCODE
  exit 3
fi

: > "$LOG_FILE"
cd "$ROOT"
PASS=true
while IFS= read -r cmd; do
  [ -z "$cmd" ] && continue
  {
    echo ">>> $cmd"
    bash -lc "$cmd"
    echo
  } >> "$LOG_FILE" 2>&1 || PASS=false
done < "$COMMANDS_FILE"

python3 - <<'PYCODE' "$JSON_FILE" "$COMMANDS_FILE" "$PASS"
from __future__ import annotations
import json
import sys
from pathlib import Path
commands = [line.strip() for line in Path(sys.argv[2]).read_text(encoding='utf-8').splitlines() if line.strip()]
payload = {
    'passed': sys.argv[3].lower() == 'true',
    'commands': commands,
}
Path(sys.argv[1]).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PYCODE

if [ "$PASS" = true ]; then
  exit 0
fi
exit 1
