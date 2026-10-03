#!/usr/bin/env bash
# Chaos checks against a local stack. Each one runs the testnet scenario (20 real payments)
# while breaking something, and passes only if exactly 20 payments are recorded and all 20
# webhooks arrive, with duplicates only ever reusing a Webhook-Id.
#
#   scripts/chaos.sh kill-worker            kill -9 the worker mid-burst, then restart it
#   scripts/chaos.sh receiver-down [secs]   receiver answers 500 for a while (default 600), then 200
#   scripts/chaos.sh postgres-down [secs]   stop Postgres mid-burst (default 60), then start it
#   scripts/chaos.sh rpc-down [secs]        worker points at a dead RPC host (default 300), then restored
#
# Before running: `pnpm build`, dev Postgres up, and the API running with
# ALLOW_INSECURE_WEBHOOK_TARGETS=true. The script starts and stops the worker itself, so stop
# any worker you have running first.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_DIR="$ROOT/apps/api"
API_URL="${API_URL:-http://localhost:4000}"
LOG_DIR="${CHAOS_LOG_DIR:-$(mktemp -d)}"
WORKER_PID=""
SCENARIO_PID=""

start_worker() { # extra env assignments may be passed as arguments
  (cd "$API_DIR" && exec env "$@" node --env-file=.env dist/worker.js) >>"$LOG_DIR/worker.log" 2>&1 &
  WORKER_PID=$!
  echo "chaos: worker started (pid $WORKER_PID)"
}

stop_worker() {
  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "-${1:-TERM}" "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  WORKER_PID=""
}

start_scenario() { # extra env assignments may be passed as arguments
  (cd "$ROOT/scripts" && exec env "$@" pnpm exec tsx scenario.ts) >"$LOG_DIR/scenario.log" 2>&1 &
  SCENARIO_PID=$!
}

wait_for_log() { # wait_for_log <pattern> <timeout seconds>
  local waited=0
  until grep -q "$1" "$LOG_DIR/scenario.log" 2>/dev/null; do
    if ! kill -0 "$SCENARIO_PID" 2>/dev/null; then echo "chaos: scenario exited early"; cat "$LOG_DIR/scenario.log"; exit 1; fi
    sleep 2; waited=$((waited + 2))
    if [ "$waited" -ge "$2" ]; then echo "chaos: timed out waiting for '$1'"; exit 1; fi
  done
}

finish() {
  local status=0
  wait "$SCENARIO_PID" || status=$?
  grep -vE "^  sent" "$LOG_DIR/scenario.log" | tail -n 40
  stop_worker
  if [ "$status" -eq 0 ]; then echo "chaos: $1 PASSED (logs in $LOG_DIR)"; else echo "chaos: $1 FAILED (logs in $LOG_DIR)"; fi
  exit "$status"
}

trap 'stop_worker; [ -n "$SCENARIO_PID" ] && kill "$SCENARIO_PID" 2>/dev/null || true' INT TERM

curl -fsS "$API_URL/health" >/dev/null || { echo "chaos: the API is not reachable at $API_URL"; exit 1; }
echo "chaos: logs in $LOG_DIR"

case "${1:-}" in
  kill-worker)
    start_worker
    start_scenario
    wait_for_log "sent 10/20" 300
    echo "chaos: kill -9 worker mid-burst"
    stop_worker KILL
    sleep 15
    start_worker
    finish kill-worker
    ;;

  receiver-down)
    SECONDS_DOWN="${2:-600}"
    start_worker
    # Retries land at 30 s, 2 min, 10 min, 30 min after each failure: allow for the next one after recovery.
    start_scenario "RECEIVER_FAIL_SECONDS=$SECONDS_DOWN" "SCENARIO_WAIT_MS=$(((SECONDS_DOWN + 1900) * 1000))"
    finish receiver-down
    ;;

  postgres-down)
    SECONDS_DOWN="${2:-60}"
    start_worker
    start_scenario
    wait_for_log "sent 5/20" 300
    echo "chaos: stopping Postgres for $SECONDS_DOWN s"
    docker compose -f "$ROOT/docker-compose.dev.yml" stop postgres >/dev/null
    sleep 5
    CODE="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/health" || true)"
    echo "chaos: /health while Postgres is down -> $CODE"
    sleep "$SECONDS_DOWN"
    docker compose -f "$ROOT/docker-compose.dev.yml" start postgres >/dev/null
    echo "chaos: Postgres started again"
    if [ "$CODE" != "503" ]; then echo "chaos: expected 503 from /health while Postgres was down"; kill "$SCENARIO_PID" 2>/dev/null || true; stop_worker; exit 1; fi
    finish postgres-down
    ;;

  rpc-down)
    SECONDS_DOWN="${2:-300}"
    start_worker
    start_scenario "SCENARIO_WAIT_MS=$(((SECONDS_DOWN + 300) * 1000))"
    wait_for_log "sending 20 payments" 300
    echo "chaos: pointing the worker at a dead RPC host for $SECONDS_DOWN s"
    stop_worker
    start_worker "STELLAR_RPC_URL=http://127.0.0.1:9"
    sleep "$SECONDS_DOWN"
    stop_worker
    if grep -q '"alert"\|ALERT' "$LOG_DIR/worker.log"; then echo "chaos: lag alert fired"; else echo "chaos: no lag alert in the worker log (expected after 2 min of lag)"; fi
    start_worker
    finish rpc-down
    ;;

  *)
    sed -n '2,13p' "$0"
    exit 2
    ;;
esac
