#!/bin/bash
# Smoke test: start server, check HTTP responses, stop
set -euo pipefail

WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$WORKDIR/dist"
PORT=20099

if [ ! -f "$DIST/out/server-main.js" ]; then
    echo "ERROR: dist/ not found. Run scripts/build.sh first." >&2
    exit 1
fi

echo "==> Starting server on port $PORT..."
node "$DIST/out/server-main.js" --host 127.0.0.1 --port "$PORT" --without-connection-token &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null" EXIT

# Wait for server to be ready
for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

echo "==> Testing HTTP endpoints..."
FAILED=0

# Discover the static base URL prefix (e.g., /stable-dev/static)
BODY=$(curl -sf "http://127.0.0.1:$PORT/")
BASE=$(echo "$BODY" | grep -oP 'href="[^"]*workbench\.css"' | head -1 | sed 's|/out/vs/code/browser/workbench/workbench.css"||;s|href="||')
echo "  Static base: $BASE"

# Test 1: Main page returns HTML
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
if [ "$STATUS" = "200" ]; then
    echo "  [OK] GET / → 200"
else
    echo "  [FAIL] GET / → $STATUS (expected 200)"
    FAILED=1
fi

# Test 2: HTML contains Cursor desktop references
if echo "$BODY" | grep -q "workbench.desktop.main.css"; then
    echo "  [OK] HTML contains desktop CSS link"
else
    echo "  [FAIL] HTML missing desktop CSS link"
    FAILED=1
fi

if echo "$BODY" | grep -q "shim.js"; then
    echo "  [OK] HTML contains shim.js"
else
    echo "  [FAIL] HTML missing shim.js"
    FAILED=1
fi

# Test 3: Desktop workbench JS is served
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT${BASE}/out/vs/workbench/workbench.desktop.main.js")
if [ "$STATUS" = "200" ]; then
    echo "  [OK] workbench.desktop.main.js → 200"
else
    echo "  [FAIL] workbench.desktop.main.js → $STATUS"
    FAILED=1
fi

# Test 4: Desktop CSS is served
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT${BASE}/out/vs/workbench/workbench.desktop.main.css")
if [ "$STATUS" = "200" ]; then
    echo "  [OK] workbench.desktop.main.css → 200"
else
    echo "  [FAIL] workbench.desktop.main.css → $STATUS"
    FAILED=1
fi

# Test 5: Shim is served
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT${BASE}/out/vs/code/browser/workbench/shim.js")
if [ "$STATUS" = "200" ]; then
    echo "  [OK] shim.js → 200"
else
    echo "  [FAIL] shim.js → $STATUS"
    FAILED=1
fi

# Test 6: CORS proxy responds
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' -X OPTIONS "http://127.0.0.1:$PORT/cors-proxy/api2.cursor.sh/")
if [ "$STATUS" = "200" ]; then
    echo "  [OK] CORS proxy OPTIONS → 200"
else
    echo "  [FAIL] CORS proxy OPTIONS → $STATUS"
    FAILED=1
fi

# Test 7: NLS messages
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT${BASE}/out/nls.messages.json")
if [ "$STATUS" = "200" ]; then
    echo "  [OK] nls.messages.json → 200"
else
    echo "  [FAIL] nls.messages.json → $STATUS"
    FAILED=1
fi

echo ""
if [ "$FAILED" = "0" ]; then
    echo "==> All checks passed!"
else
    echo "==> Some checks FAILED"
    exit 1
fi
