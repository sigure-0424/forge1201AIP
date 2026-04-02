#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/tk_common.sh"

ROOT="$(tk_repo_root)"
cd "$ROOT"

"$ROOT/scripts/print_banner.sh"

if ! command -v gh >/dev/null 2>&1; then
  echo "[tk_start_copilot] gh CLI not found in PATH."
  
fi

if ! command -v copilot >/dev/null 2>&1; then
  echo "[tk_start_copilot] gh copilot extension not installed. Run: gh extension install github/gh-copilot"
  exit 1
fi

BOOT_PROMPT=$(cat <<'EOF'
BOOT PROTOCOL (mandatory):
1. Read EVERYTHING in docs/core/ before any reasoning.
2. Report only STATE fields by quoting docs/core/STATE.yaml; do not invent values.
3. If active_tasks is empty, enumerate docs/proposed/ and select the best next task.
4. Respect No-Confirm Mode: if the operator says "No approval required" or equivalent, proceed without asking.
5. Handle transient locks or sync conflicts by wait / switch tasks / retry.
6. Keep notebooks thin and prefer Docker + data/sample verification when project-specific verification exists.
EOF
)

exec gh copilot suggest -t shell "$BOOT_PROMPT"
