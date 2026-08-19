#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/tk_common.sh"

ROOT="$(tk_repo_root)"
cd "$ROOT"

DISPLAY_NAME="$(basename "$ROOT")"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo no-git)"
WORKSPACE="$(tk_workspace_name)"

printf '\n'
printf '========================================\n'
printf ' %s\n' "$DISPLAY_NAME"
printf ' GIT_COMMIT_SHA : %s\n' "$GIT_SHA"
printf ' WORKSPACE      : %s\n' "$WORKSPACE"
printf '========================================\n'
printf '\n'
