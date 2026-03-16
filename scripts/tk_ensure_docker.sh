#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/tk_common.sh"

ROOT="$(tk_repo_root)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "[tk_ensure_docker] docker not found; skipping."
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "[tk_ensure_docker] docker daemon not reachable; skipping."
  exit 0
fi

if [ ! -f docker/compose.yaml ]; then
  echo "[tk_ensure_docker] docker/compose.yaml not found; skipping."
  exit 0
fi

echo "[tk_ensure_docker] ensuring docker compose dev is up..."
docker compose -f docker/compose.yaml up -d
docker compose -f docker/compose.yaml ps
