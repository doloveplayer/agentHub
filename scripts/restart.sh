#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')
LOG_DIR="$PROJECT_ROOT/logs/$TIMESTAMP"
mkdir -p "$LOG_DIR"
BACKEND_LOG="$LOG_DIR/backend.log"

echo "=== AgentHub Quick Restart ($TIMESTAMP) ==="
echo ""

# --- Kill backend ---
echo "[1/3] Stopping backend..."
fuser -k 3000/tcp 2>/dev/null && echo "  ✓ stopped backend" || echo "  - backend not running"

# --- Export env vars ---
set -a
source <(grep -v '^\s*#' .env | grep -v '^\s*$')
set +a

# --- Start backend ---
echo "[2/3] Starting backend (port 3000)..."
cd apps/api
npx tsx src/index.ts >> "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
echo "  ✓ backend pid=$BACKEND_PID"
cd "$PROJECT_ROOT"

# --- Wait for backend ---
echo "[3/3] Waiting for backend..."
for i in $(seq 1 20); do
  if curl -s http://localhost:3000/api >/dev/null 2>&1; then
    echo "  ✓ backend is ready"
    break
  fi
  if [ $i -eq 20 ]; then
    echo "  ✗ backend failed to start (check $BACKEND_LOG)"
    exit 1
  fi
  sleep 1
done

echo ""
echo "=== Backend restarted ==="
echo "  Backend:  http://localhost:3000  (log: $BACKEND_LOG)"
echo "  Frontend: http://localhost:5175  (unchanged)"
echo ""
echo "PID: backend=$BACKEND_PID"
echo "To full restart:  bash scripts/startup.sh"
echo "To full stop:     bash scripts/cleanup.sh"
