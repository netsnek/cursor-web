# Cursor Web

Run [Cursor](https://cursor.sh) in the browser using VS Code Web as the backend.

## Architecture

```
Browser
  |
  |  Cursor Desktop Workbench (workbench.desktop.main.js)
  |  — Full Cursor UI: login, chat, agent mode, extensions
  |  — Thinks it's running in Electron (Cursor desktop app)
  |
  |  Shim (adapter/shim.js)
  |  — Bridges Electron IPC APIs to browser equivalents
  |  — CORS proxy for external API calls
  |  — MessagePort protocol, channel handlers, auth seeding
  |
  v
VS Code Web Server (server-main.js)
  — Terminal via WebSocket (remote terminal backend)
  — File system via WebSocket
  — Extension host (Cursor's, with AI transport)
  — Search, debugging, git — all via WebSocket
```

**The Cursor Desktop Workbench** (`workbench.desktop.main.js`) is Cursor's full UI bundle — it provides the complete Cursor interface including login/signup, onboarding, AI chat, composer, agent mode, and all editor features. It was originally built for Electron (Cursor's desktop app), hence the name "desktop". In Cursor Web, it runs in the browser with a shim that bridges the Electron APIs it expects.

**VS Code Web** (`server-main.js`) is the backend. It's built from [VS Code OSS](https://github.com/microsoft/vscode) source using the `vscode-reh-web` (Remote Extension Host Web) build target. It provides terminal, file system, extension host, and all other services over WebSocket — the same way VS Code Remote works, but served to the browser.

**The shim** (`adapter/shim.js`) bridges the gap. The Cursor Desktop Workbench expects Electron's IPC (`ipcRenderer.send/invoke/on`), MessagePort protocol, native host APIs, sign service, storage, and more. The shim implements all of these using browser APIs (localStorage, fetch, MessageChannel, etc.) and stubs out what can't work in a browser (local PTY, native clipboard, window management).

## How it works

1. **Build VS Code Web from source** — `vscode/` submodule at the matching VS Code version
2. **Apply patches** — CORS proxy, product.json merge, HTML modifications
3. **Overlay Cursor assets** — desktop workbench JS/CSS, extensions, NLS, media, extension host
4. **Disable local terminal backend** — the desktop workbench registers both local (Electron IPC) and remote (WebSocket) terminal backends; we disable local since there's no Electron
5. **Result**: single `node` process serving everything on one port

## Quick start

```bash
# Extract Cursor (downloads AppImage, extracts overlay assets)
scripts/extract-cursor.sh latest arm64   # or amd64

# Build VS Code Web + overlay Cursor
scripts/build.sh

# Run
node dist/out/server-main.js --host 0.0.0.0 --port 20000 --without-connection-token
```

Open `http://localhost:20000` in your browser. You'll see the Cursor login page. Log in with your Cursor account, or click "Skip Login" to use without AI features.

## Directory structure

```
cursor-web/
  vscode/              VS Code OSS (git submodule)
  adapter/
    shim.js            Electron-to-browser bridge (IPC, CORS, auth, boot)
  patches/
    cursor-web.patch   TypeScript source patches for VS Code
  scripts/
    extract-cursor.sh  Download + extract Cursor AppImage
    build.sh           Build VS Code Web + overlay Cursor
    merge-product.py   Merge VS Code + Cursor product.json
  cursor-overlay/      Extracted Cursor assets (not in git)
  dist/                Build output (not in git)
```

## Requirements

- Node.js 20+
- Python 3
- Git
- ~4 GB disk for build

## License

VS Code OSS is MIT licensed. Cursor's compiled assets are subject to [Cursor's Terms of Service](https://cursor.sh/terms).
