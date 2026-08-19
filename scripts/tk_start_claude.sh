#This is just start claude code easy and quickly.
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/tk_common.sh"

ROOT="$(tk_repo_root)"
cd "$ROOT"

"$ROOT/scripts/print_banner.sh"

if ! command -v claude >/dev/null 2>&1; then
  echo "[tk_start_claude] claude not found in PATH."
  exit 1
fi

MASTER_GUIDANCE_PATH="$ROOT/docs/core/MASTER_GUIDANCE.xml"

if [ ! -f "$MASTER_GUIDANCE_PATH" ]; then
  echo "[tk_start_claude] MASTER_GUIDANCE.xml not found at $MASTER_GUIDANCE_PATH."
  exit 1
fi

exec claude \
  --dangerously-skip-permissions \
  --append-system-prompt-file "$MASTER_GUIDANCE_PATH" \
  "BOOT: follow the injected startup protocol."