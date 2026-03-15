#!/bin/bash
# Run all tests against a running or freshly started server
# Usage: test/run.sh [--start] [--port PORT]
set -euo pipefail

WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=20000
START_SERVER=0
SERVER_PID=""

for arg in "$@"; do
    case "$arg" in
        --start) START_SERVER=1 ;;
        --port) shift; PORT="$1" ;;
        --port=*) PORT="${arg#--port=}" ;;
    esac
    shift 2>/dev/null || true
done

cleanup() {
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null
        wait "$SERVER_PID" 2>/dev/null
    fi
}
trap cleanup EXIT

if [ "$START_SERVER" = "1" ]; then
    echo "==> Starting server on port $PORT..."
    node "$WORKDIR/dist/out/server-main.js" --host 127.0.0.1 --port "$PORT" --without-connection-token &
    SERVER_PID=$!
    for i in $(seq 1 30); do
        curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
        sleep 1
    done
    echo ""
fi

echo "============================================"
echo "  Cursor Web Test Suite"
echo "  Server: http://127.0.0.1:$PORT"
echo "============================================"
echo ""

TOTAL_FAIL=0

# 1. HTTP endpoint tests
echo "--- HTTP Tests ---"
bash "$WORKDIR/test/http.sh" "$PORT" || ((TOTAL_FAIL++))
echo ""

# 2. Headless browser tests
echo "--- Browser Tests ---"
node "$WORKDIR/test/browser.mjs" --port "$PORT" --timeout 25 || ((TOTAL_FAIL++))
echo ""

# 3. Login persistence test
echo "--- Login Tests ---"
node "$WORKDIR/test/login.mjs" --port "$PORT" --timeout 15 || ((TOTAL_FAIL++))
echo ""

# 4. Workbench integration test (extension host, IPC, CSP, MIME, product.json)
echo "--- Workbench Integration Tests ---"
node "$WORKDIR/test/workbench.mjs" --port "$PORT" --timeout 25 || ((TOTAL_FAIL++))
echo ""

echo "============================================"
if [ "$TOTAL_FAIL" -eq 0 ]; then
    echo "  ALL TEST SUITES PASSED"
else
    echo "  $TOTAL_FAIL TEST SUITE(S) FAILED"
fi
echo "============================================"
exit "$TOTAL_FAIL"
