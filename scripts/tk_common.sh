#!/usr/bin/env bash
set -euo pipefail

tk_repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

tk_state_value() {
  local key="$1"
  local state_file
  state_file="$(tk_repo_root)/docs/core/STATE.yaml"
  if [ ! -f "$state_file" ]; then
    return 1
  fi
  awk -F': ' -v key="$key" '$1 == key { sub(/^[[:space:]]+/, "", $2); gsub(/^"|"$/, "", $2); print $2; exit }' "$state_file"
}

tk_workspace_name() {
  if [ -f /.dockerenv ]; then
    echo "docker"
  elif grep -qi microsoft /proc/version 2>/dev/null; then
    echo "wsl"
  else
    echo "local"
  fi
}

tk_abbreviate_name() {
  local name="$1"
  local limit="${2:-24}"
  if [ "${#name}" -le "$limit" ]; then
    printf '%s' "$name"
    return 0
  fi
  printf '%s…' "${name:0:$((limit-1))}"
}
