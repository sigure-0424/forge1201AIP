#!/usr/bin/env bash
set -euo pipefail

tk_repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
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
