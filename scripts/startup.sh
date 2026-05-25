#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')

echo "=== AgentHub Startup ($TIMESTAMP) ==="
echo "Logs: $LOG_DIR/"
echo ""

# --- Ensure .env exists ---
if [ ! -f .env ]; then
  echo "✗ .env file not found at $PROJECT_ROOT/.env"
  exit 1
fi

# --- Export env vars (for Prisma, etc.) ---
set -a
source <(grep -v '^\s*#' .env | grep -v '^\s*$')
set +a

# --- Start docker compose services ---
echo "[1/4] Starting docker compose services..."
docker compose up -d postgres 2>&1 | tee -a "$BACKEND_LOG"
echo "  ✓ postgres started"

# Wait for postgres to be healthy
echo "  waiting for postgres..."
until docker compose exec -T postgres pg_isready -U agenthub 2>/dev/null; do
  sleep 1
done
echo "  ✓ postgres is ready"

# Optional: start redis if REDIS_URL is configured
if [ -n "${REDIS_URL:-}" ]; then
  if docker compose up -d redis 2>&1 | tee -a "$BACKEND_LOG"; then
    echo "  ✓ redis started"
  else
    echo "  ⚠ redis failed (port 6379 in use?) — continuing without it"
  fi
fi

# --- Run Prisma migrate ---
echo "[2/4] Running database migrations..."
cd apps/api
npx prisma migrate deploy 2>&1 | tee -a "$BACKEND_LOG" || {
  echo "  ! migrate deploy failed, trying dev..."
  npx prisma migrate dev --name init 2>&1 | tee -a "$BACKEND_LOG"
}
echo "  ✓ migrations complete"
cd "$PROJECT_ROOT"

# --- Start backend ---
echo "[3/4] Starting backend (port 3000)..."
cd apps/api
npx tsx src/index.ts >> "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
echo "  ✓ backend pid=$BACKEND_PID"
cd "$PROJECT_ROOT"

# Wait for backend to be ready
echo "  waiting for backend..."
for i in $(seq 1 30); do
  if curl -s http://localhost:3000/api >/dev/null 2>&1; then
    echo "  ✓ backend is ready"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "  ✗ backend failed to start (check $BACKEND_LOG)"
    exit 1
  fi
  sleep 1
done

# --- Start frontend ---
echo "[4/4] Starting frontend (port 5175)..."
cd apps/web
npx vite --host 127.0.0.1 >> "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!
echo "  ✓ frontend pid=$FRONTEND_PID"
cd "$PROJECT_ROOT"

# --- Summary ---
echo ""
echo "=== AgentHub is running ==="
echo "  Backend:  http://localhost:3000  (log: $BACKEND_LOG)"
echo "  Frontend: http://localhost:5175  (log: $FRONTEND_LOG)"
echo ""
echo "PIDs: backend=$BACKEND_PID  frontend=$FRONTEND_PID"
echo "To stop:  bash scripts/cleanup.sh"
echo "To tail logs:  tail -f $LOG_DIR/*.log"
