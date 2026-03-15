#!/bin/bash
# Download and extract Cursor release into cursor-overlay/
# Usage: extract-cursor.sh [version|latest] [arch: amd64|arm64]
set -euo pipefail

VERSION="${1:-latest}"
ARCH="${2:-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}"
WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY="$WORKDIR/cursor-overlay"
TMPDIR="${WORKDIR}/.tmp-extract"

echo "==> Extracting Cursor (version=$VERSION, arch=$ARCH)"

# 1. Download Cursor AppImage
mkdir -p "$TMPDIR"
APPIMAGE="$TMPDIR/cursor-${ARCH}.AppImage"

if [ "$VERSION" = "latest" ]; then
  if [ "$ARCH" = "amd64" ]; then
    URL="https://api2.cursor.sh/updates/download/golden/linux-x64/cursor/latest"
  else
    URL="https://downloader.cursor.sh/linux/appImage/arm64"
  fi
else
  # Specific version — try the golden URL with version
  if [ "$ARCH" = "amd64" ]; then
    URL="https://api2.cursor.sh/updates/download/golden/linux-x64/cursor/${VERSION}"
  else
    URL="https://downloader.cursor.sh/linux/appImage/arm64"
  fi
fi

if [ ! -f "$APPIMAGE" ]; then
  echo "==> Downloading Cursor AppImage ($ARCH)..."
  curl -L -o "$APPIMAGE" "$URL"
else
  echo "==> Using cached AppImage: $APPIMAGE"
fi

# 2. Extract AppImage
echo "==> Extracting AppImage..."
rm -rf "$TMPDIR/squashfs-root"
cd "$TMPDIR"

# Find squashfs offset and extract (try unsquashfs first, fall back to --appimage-extract)
OFFSET=$(grep -aobP 'hsqs' "$APPIMAGE" | tail -1 | cut -d: -f1 || true)
EXTRACTED=0
if [ -n "$OFFSET" ] && command -v unsquashfs &>/dev/null; then
  if unsquashfs -o "$OFFSET" -d squashfs-root "$APPIMAGE" >/dev/null 2>&1; then
    EXTRACTED=1
  fi
fi
if [ "$EXTRACTED" = "0" ]; then
  chmod +x "$APPIMAGE"
  "$APPIMAGE" --appimage-extract >/dev/null 2>&1
fi

# 3. Find app root (handles different AppImage layouts)
if [ -f "squashfs-root/usr/share/cursor/resources/app/product.json" ]; then
  APP_ROOT="squashfs-root/usr/share/cursor/resources/app"
elif [ -f "squashfs-root/resources/app/product.json" ]; then
  APP_ROOT="squashfs-root/resources/app"
else
  echo "ERROR: Cannot find product.json in extracted AppImage" >&2
  exit 1
fi
echo "==> App root: $APP_ROOT"

# 4. Read versions
CURSOR_VERSION=$(python3 -c "import json; print(json.load(open('$APP_ROOT/product.json'))['version'])")
VSCODE_VERSION=$(python3 -c "import json; print(json.load(open('$APP_ROOT/product.json'))['vscodeVersion'])")
echo "==> Cursor $CURSOR_VERSION (VS Code $VSCODE_VERSION)"

# 5. Copy to cursor-overlay/
rm -rf "$OVERLAY"
mkdir -p "$OVERLAY"/{out/vs/workbench,out/vs/workbench/api/node,out/media,extensions}

# Workbench bundles
cp "$APP_ROOT/out/vs/workbench/workbench.desktop.main.js" "$OVERLAY/out/vs/workbench/"
cp "$APP_ROOT/out/vs/workbench/workbench.desktop.main.css" "$OVERLAY/out/vs/workbench/"

# NLS
cp "$APP_ROOT/out/nls.messages.json" "$OVERLAY/out/"

# Extension host
cp "$APP_ROOT/out/vs/workbench/api/node/extensionHostProcess.js" "$OVERLAY/out/vs/workbench/api/node/"

# Media (fonts, logos, icons)
for f in \
  media/codicon.ttf \
  media/cursor-icons-outline.woff2 \
  media/jetbrains-mono-regular.ttf \
  media/logo.png \
  media/agents-toggle-filled.svg \
  media/agents-toggle-outline.svg \
; do
  [ -f "$APP_ROOT/out/$f" ] && cp "$APP_ROOT/out/$f" "$OVERLAY/out/$f"
done

# Workbench media
mkdir -p "$OVERLAY/out/vs/workbench/browser/parts/editor/media"
for f in \
  vs/workbench/browser/parts/editor/media/lockup-horizontal-dark.png \
  vs/workbench/browser/parts/editor/media/lockup-horizontal-light.png \
  vs/workbench/browser/parts/editor/media/logo.png \
  vs/workbench/browser/parts/editor/media/back-tb.png \
  vs/workbench/browser/parts/editor/media/forward-tb.png \
; do
  [ -f "$APP_ROOT/out/$f" ] && cp "$APP_ROOT/out/$f" "$OVERLAY/out/$f"
done

# Extensions management media
mkdir -p "$OVERLAY/out/vs/workbench/services/extensionManagement/common/media"
[ -f "$APP_ROOT/out/vs/workbench/services/extensionManagement/common/media/defaultIcon.png" ] && \
  cp "$APP_ROOT/out/vs/workbench/services/extensionManagement/common/media/defaultIcon.png" \
     "$OVERLAY/out/vs/workbench/services/extensionManagement/common/media/"

# Cursor extensions
for ext in "$APP_ROOT/extensions"/cursor-*/ "$APP_ROOT/extensions"/theme-cursor/; do
  [ -d "$ext" ] && cp -a "$ext" "$OVERLAY/extensions/"
done

# Product.json (reference)
cp "$APP_ROOT/product.json" "$OVERLAY/product.json"

# 6. Write VERSION file
echo "$CURSOR_VERSION" > "$WORKDIR/VERSION"
echo "vscode=$VSCODE_VERSION" >> "$WORKDIR/VERSION"

# 7. Cleanup
rm -rf "$TMPDIR/squashfs-root"

echo "==> Extraction complete!"
echo "    Cursor: $CURSOR_VERSION"
echo "    VS Code: $VSCODE_VERSION"
echo "    Overlay: $OVERLAY"
ls -lh "$OVERLAY/out/vs/workbench/workbench.desktop.main.js"
