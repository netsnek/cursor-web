#!/bin/bash
# HTTP endpoint smoke tests — verifies server responses
# Expects server already running on PORT (default 20000)
set -euo pipefail

PORT="${1:-20000}"
BASE_URL="http://127.0.0.1:$PORT"
FAILED=0
PASSED=0

pass() { echo "  [PASS] $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  [FAIL] $1${2:+: $2}"; FAILED=$((FAILED + 1)); }

echo "==> HTTP endpoint tests (port $PORT)"

# Discover static base URL prefix
BODY=$(curl -sf "$BASE_URL/")
STATIC_BASE=$(echo "$BODY" | grep -oP 'href="[^"]*workbench\.css"' | head -1 | sed 's|/out/vs/code/browser/workbench/workbench.css"||;s|href="||')
echo "    Static base: $STATIC_BASE"

# 1. Main page
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE_URL/")
[ "$STATUS" = "200" ] && pass "GET / → 200" || fail "GET / → $STATUS"

# 2. HTML contains desktop CSS link
echo "$BODY" | grep -q "workbench.desktop.main.css" && pass "HTML has desktop CSS" || fail "HTML missing desktop CSS"

# 3. HTML contains shim.js
echo "$BODY" | grep -q "shim.js" && pass "HTML has shim.js" || fail "HTML missing shim.js"

# 4. HTML contains NLS loader
echo "$BODY" | grep -q "nls.messages" && pass "HTML has NLS loader" || fail "HTML missing NLS loader"

# 5. Desktop workbench JS
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE_URL${STATIC_BASE}/out/vs/workbench/workbench.desktop.main.js")
[ "$STATUS" = "200" ] && pass "workbench.desktop.main.js → 200" || fail "workbench.desktop.main.js → $STATUS"

# 6. Desktop CSS
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE_URL${STATIC_BASE}/out/vs/workbench/workbench.desktop.main.css")
[ "$STATUS" = "200" ] && pass "workbench.desktop.main.css → 200" || fail "workbench.desktop.main.css → $STATUS"

# 7. Shim JS
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE_URL${STATIC_BASE}/out/vs/code/browser/workbench/shim.js")
[ "$STATUS" = "200" ] && pass "shim.js → 200" || fail "shim.js → $STATUS"

# 8. NLS messages
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE_URL${STATIC_BASE}/out/nls.messages.json")
[ "$STATUS" = "200" ] && pass "nls.messages.json → 200" || fail "nls.messages.json → $STATUS"

# 9. CORS proxy OPTIONS
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE_URL/cors-proxy/api2.cursor.sh/")
[ "$STATUS" = "200" ] && pass "CORS proxy OPTIONS → 200" || fail "CORS proxy OPTIONS → $STATUS"

# 10. CORS proxy GET (actual proxy to cursor API)
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/cors-proxy/api2.cursor.sh/" 2>/dev/null || echo "timeout")
if [ "$STATUS" = "timeout" ]; then
    fail "CORS proxy GET → timeout (api2.cursor.sh unreachable?)"
else
    # Any non-502 response means the proxy is working (404/403 from upstream is fine)
    [ "$STATUS" != "502" ] && pass "CORS proxy GET → $STATUS (proxy works)" || fail "CORS proxy GET → 502"
fi

# 11. WebSocket upgrade endpoint exists
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/stable-dev/?reconnectionToken=test&reconnection=false&skipWebSocketFrames=false" 2>/dev/null || true)
# WebSocket upgrade returns 400 or similar for non-WS request — that's expected
[ "$STATUS" != "000" ] && pass "WebSocket endpoint responds ($STATUS)" || fail "WebSocket endpoint unreachable"

# 12. Version endpoint
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE_URL/version")
[ "$STATUS" = "200" ] && pass "/version → 200" || fail "/version → $STATUS"

# 13. Desktop JS is large enough (>10MB means Cursor bundle, not VS Code web)
SIZE=$(curl -sf "$BASE_URL${STATIC_BASE}/out/vs/workbench/workbench.desktop.main.js" | wc -c)
SIZE_MB=$((SIZE / 1048576))
[ "$SIZE_MB" -ge 10 ] && pass "Desktop JS is ${SIZE_MB}MB (Cursor bundle)" || fail "Desktop JS only ${SIZE_MB}MB (expected >10MB)"

# 14. Codicon font served
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL${STATIC_BASE}/out/media/codicon.ttf" 2>/dev/null || true)
[ "$STATUS" = "200" ] && pass "codicon.ttf → 200" || fail "codicon.ttf → $STATUS"

# 15. Cursor extensions present (check package.json or dist/ directory)
for ext in cursor-retrieval theme-cursor cursor-mcp; do
    STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL${STATIC_BASE}/extensions/$ext/package.json" 2>/dev/null || true)
    [ "$STATUS" = "200" ] && pass "Extension $ext → 200" || fail "Extension $ext → $STATUS"
done

echo ""
echo "==> Results: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
