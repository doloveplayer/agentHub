#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

DEEP=false
for arg in "$@"; do
  case "$arg" in
    --deep) DEEP=true ;;
  esac
done

echo "=== AgentHub Cleanup ==="
[ "$DEEP" = true ] && echo "Mode: deep (--deep)"
echo ""

# --- Kill running dev servers ---
echo "[1/6] Killing dev servers..."
fuser -k 3000/tcp 2>/dev/null && echo "  ✓ stopped backend (port 3000)" || echo "  - backend not running"
fuser -k 5175/tcp 2>/dev/null && echo "  ✓ stopped frontend (port 5175)" || echo "  - frontend not running"
fuser -k 5173/tcp 2>/dev/null && echo "  ✓ stopped dashboard (port 5173)" || echo "  - dashboard not running"
fuser -k 6379/tcp 2>/dev/null && echo "  ✓ freed redis port (6379)" || echo "  - port 6379 free"

# Deep: also kill orphan node/tsx/vite processes started by this project
if [ "$DEEP" = true ]; then
  echo "  [deep] Killing residual node processes..."
  pkill -f "tsx src/index.ts" 2>/dev/null && echo "  ✓ killed tsx backend" || true
  pkill -f "vite.*--host" 2>/dev/null && echo "  ✓ killed vite frontend" || true
fi

# --- Remove agent sandbox containers ---
echo "[2/6] Removing agent sandbox containers..."
SANDBOX_COUNT=$(docker ps -aq --filter name=agenthub-sandbox 2>/dev/null | wc -l)
if [ "$SANDBOX_COUNT" -gt 0 ]; then
  docker rm -f $(docker ps -aq --filter name=agenthub-sandbox) 2>/dev/null
  echo "  ✓ removed $SANDBOX_COUNT sandbox container(s)"
else
  echo "  - no sandbox containers"
fi

# --- Clean sandbox directories ---
echo "[3/6] Cleaning sandbox directories..."
if [ -d .sandboxes ] && [ "$(ls -A .sandboxes 2>/dev/null)" ]; then
  rm -rf .sandboxes/*
  echo "  ✓ cleaned .sandboxes/"
else
  echo "  - .sandboxes/ already empty"
fi

# --- Stop docker compose services ---
if [ "$DEEP" = true ]; then
  echo "[4/6] Stopping docker compose services + removing volumes..."
  docker compose down --remove-orphans -v 2>/dev/null && echo "  ✓ postgres + redis stopped, volumes removed" || echo "  - docker compose not running"
else
  echo "[4/6] Stopping docker compose services..."
  docker compose down --remove-orphans 2>/dev/null && echo "  ✓ postgres + redis stopped" || echo "  - docker compose not running"
fi

# --- Clean temp/logs ---
echo "[5/6] Cleaning temp files..."
rm -rf /tmp/agenthub-* 2>/dev/null || true
echo "  ✓ temp files removed"

if [ "$DEEP" = true ]; then
  if [ -d "$PROJECT_ROOT/logs" ] && [ "$(ls -A "$PROJECT_ROOT/logs" 2>/dev/null)" ]; then
    rm -rf "$PROJECT_ROOT/logs/"*
    echo "  [deep] ✓ cleaned logs/"
  else
    echo "  [deep] - logs/ already empty"
  fi
fi

# --- Clean stale Docker resources ---
echo "[6/6] Cleaning stale Docker resources..."
docker container prune -f 2>/dev/null && echo "  ✓ stopped containers removed" || true

if [ "$DEEP" = true ]; then
  docker volume prune -f 2>/dev/null && echo "  [deep] ✓ dangling volumes pruned" || true
fi

echo ""
echo "=== Cleanup complete ==="
[ "$DEEP" = true ] && echo "Deep cleanup: volumes, logs, residual processes all removed."
