#!/bin/bash
# Build VS Code Web from source + overlay Cursor bundles
# Usage: build.sh [x64|arm64]
set -euo pipefail

ARCH=${1:-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')}
WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Extract Cursor if not already done
if [ ! -d "$WORKDIR/cursor-overlay" ]; then
    EXTRACT_ARCH=$(echo "$ARCH" | sed 's/x64/amd64/')
    "$WORKDIR/scripts/extract-cursor.sh" latest "$EXTRACT_ARCH"
fi

# 2. Apply patches to VS Code source
cd "$WORKDIR/vscode"
git checkout -- .  # Reset any previous patches
git apply ../patches/cursor-web.patch

# 3. Merge product.json (VS Code base + Cursor additions)
python3 "$WORKDIR/scripts/merge-product.py" \
    "$WORKDIR/vscode/product.json" \
    "$WORKDIR/cursor-overlay/product.json" \
    "$WORKDIR/vscode/product.json"

# 4. Build VS Code Web (Remote Extension Host Web)
cd "$WORKDIR/vscode"
npm ci
npx gulp vscode-reh-web-linux-${ARCH}-min

# 5. Assemble dist/
cd "$WORKDIR"
VSCODE_OUT="$WORKDIR/vscode-reh-web-linux-${ARCH}"
if [ ! -d "$VSCODE_OUT" ]; then
    echo "ERROR: Build output not found at $VSCODE_OUT" >&2
    exit 1
fi
rm -rf dist
cp -a "$VSCODE_OUT" dist/

# 6. Overlay Cursor bundles
# Desktop workbench (replaces web workbench)
cp cursor-overlay/out/vs/workbench/workbench.desktop.main.js dist/out/vs/workbench/
cp cursor-overlay/out/vs/workbench/workbench.desktop.main.css dist/out/vs/workbench/

# Extension host
cp cursor-overlay/out/vs/workbench/api/node/extensionHostProcess.js dist/out/vs/workbench/api/node/

# NLS messages
cp cursor-overlay/out/nls.messages.json dist/out/

# Media assets (fonts, icons, logos)
for f in cursor-overlay/out/media/*; do
    [ -f "$f" ] && cp "$f" dist/out/media/
done

# Workbench media (editor logos)
mkdir -p dist/out/vs/workbench/browser/parts/editor/media
for f in cursor-overlay/out/vs/workbench/browser/parts/editor/media/*; do
    [ -f "$f" ] && cp "$f" dist/out/vs/workbench/browser/parts/editor/media/
done

# Extension management media
mkdir -p dist/out/vs/workbench/services/extensionManagement/common/media
[ -f "cursor-overlay/out/vs/workbench/services/extensionManagement/common/media/defaultIcon.png" ] && \
    cp "cursor-overlay/out/vs/workbench/services/extensionManagement/common/media/defaultIcon.png" \
       "dist/out/vs/workbench/services/extensionManagement/common/media/"

# Cursor extensions
for ext in cursor-overlay/extensions/*/; do
    [ -d "$ext" ] && cp -a "$ext" dist/extensions/
done

# 7. Install shim
cp adapter/shim.js dist/out/vs/code/browser/workbench/shim.js

# 8. Install Cursor-specific node_modules (not in VS Code's deps)
# Cursor's extension host needs @sentry, @opentelemetry, and many other packages.
# Copy from extracted Cursor overlay, replacing VS Code's versions where needed
# (e.g. chownr 1.x CJS → 3.x ESM required by opentelemetry).
CURSOR_MODULES="$WORKDIR/cursor-overlay/node_modules"
if [ -d "$CURSOR_MODULES" ]; then
    echo "==> Copying Cursor node_modules..."
    for pkg in "$CURSOR_MODULES"/*; do
        PKG_NAME=$(basename "$pkg")
        cp -a "$pkg" "$WORKDIR/dist/node_modules/$PKG_NAME"
    done
fi

# 9. Stub for @vscode/windows-process-tree (Windows-only, not needed on Linux)
mkdir -p dist/node_modules/@vscode/windows-process-tree
echo 'module.exports={getProcessTree:()=>undefined,getProcessList:()=>[]};' > dist/node_modules/@vscode/windows-process-tree/index.js
echo '{"name":"@vscode/windows-process-tree","version":"0.0.0","main":"index.js"}' > dist/node_modules/@vscode/windows-process-tree/package.json

# 9. Create Electron stub for cursor extensions that require('electron')
mkdir -p dist/out/node_modules/electron
cat > dist/out/node_modules/electron/index.js << 'ELECTRON_STUB'
// Stub: cursor extensions import electron for IPC — not available in serve-web
module.exports = {
    ipcRenderer: { send() {}, invoke() { return Promise.resolve(); }, on() { return this; }, once() { return this; } },
    shell: { openExternal(url) { return Promise.resolve(); } },
    clipboard: { readText() { return ''; }, writeText() {} },
    app: { getPath() { return '/tmp'; }, getVersion() { return '32.0.0'; } },
};
ELECTRON_STUB

echo ""
echo "==> Build complete!"
echo "    Output: $WORKDIR/dist/"
echo "    Start:  node dist/out/server-main.js --host 0.0.0.0 --port 20000 --without-connection-token"
