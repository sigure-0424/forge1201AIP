#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/tk_common.sh"

ROOT="$(tk_repo_root)"
cd "$ROOT"

PROJECT_SHORT_NAME="$(tk_state_value project_short_name 2>/dev/null || true)"
PROJECT_NAME="$(tk_state_value project_name 2>/dev/null || true)"
PROTOCOL_VERSION="$(tk_state_value protocol_version 2>/dev/null || echo unknown)"

if [ -n "$PROJECT_SHORT_NAME" ]; then
  DISPLAY_NAME="$PROJECT_SHORT_NAME"
elif [ -n "$PROJECT_NAME" ]; then
  DISPLAY_NAME="$(tk_abbreviate_name "$PROJECT_NAME")"
else
  DISPLAY_NAME="PROJECT"
fi

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo no-git)"
WORKSPACE="$(tk_workspace_name)"

printf '\n'
printf '========================================\n'
printf ' %s\n' "$DISPLAY_NAME"
printf ' PROTOCOL_VERSION: %s\n' "$PROTOCOL_VERSION"
printf ' GIT_COMMIT_SHA : %s\n' "$GIT_SHA"
printf ' WORKSPACE      : %s\n' "$WORKSPACE"
printf '========================================\n'
printf '\n'
