#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/tk_common.sh"

ROOT="$(tk_repo_root)"
cd "$ROOT"

"$ROOT/scripts/print_banner.sh"

cat <<'EOF'
AI launch menu
  1) none   - no AI agent, keep only a shell
  2) gemini  - start Gemini only
  3) claude - start Claude only
  4) both   - do not auto-launch here; switch Terminal Keeper session to "ai-both"
  5) help   - show direct wrapper paths
EOF

read -r -p "Select [1/2/3/4/5] (default: 1): " choice
choice="${choice:-1}"

case "$choice" in
  1|none|NONE)
    echo "[tk_start_ai_session] No AI agent started."
    exec bash
    ;;
  2|gemini|GEMINI)
    exec "$ROOT/scripts/tk_start_gemini.sh"
    ;;
  3|claude|CLAUDE)
    exec "$ROOT/scripts/tk_start_claude.sh"
    ;;
  4|both|BOTH)
    echo "[tk_start_ai_session] Use the Terminal Keeper session named 'ai-both' when you want separate Claude and Gemini terminals."
    exec bash
    ;;
  5|help|HELP)
    cat <<'EOF'
Direct wrappers:
- ./scripts/tk_start_claude.sh
- ./scripts/tk_start_gemini.sh
Terminal Keeper presets:
- default
- claude-only
- gemini-only
- ai-both
EOF
    exec bash
    ;;
  *)
    echo "[tk_start_ai_session] Invalid selection: $choice"
    exec bash
    ;;
esac
