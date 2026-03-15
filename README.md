# Cursor Web

Run [Cursor](https://cursor.sh) in the browser using VS Code Web as the backend.

## Architecture

```
Browser
  │
  │  Cursor Desktop Workbench (workbench.desktop.main.js)
  │  — Full Cursor UI: login, chat, agent mode, extensions
  │  — Thinks it's running in Electron (Cursor desktop app)
  │
  │  Shim (adapter/shim.js)
  │  — Bridges Electron IPC to browser + VS Code Web backend
  │  — IPC binary protocol (varint serialization, channels, events)
  │  — CORS proxy, auth seeding, MessagePort protocol
  │
  ├──── IPC channels (Electron main process emulation) ────┐
  │     nativeHost, sign/vsda, storage, keyboardLayout,    │
  │     localFilesystem, extensions, extensionHostStarter,  │
  │     localPty, workspaces, userDataProfiles, update, ... │
  │                                                         │
  │     localPty ──WebSocket──► PTY Server (pty-server.js)  │
  │                             node-pty process management │
  │                                                         │
  ├──── Remote channels (VS Code Web server) ──────────────┤
  │     remoteterminal, remoteFilesystem, remoteExtensions, │
  │     search, debug, git, file watcher                    │
  │                                                         │
  v                                                         │
VS Code Web Server (server-main.js) ◄──────────────────────┘
  — Terminal via WebSocket (remote terminal backend)
  — File system via WebSocket
  — Extension host (runs Cursor extensions)
  — Search, debugging, git — all via WebSocket
  — CORS proxy middleware (same-origin API calls)
```

## How the IPC bridge works

The Cursor Desktop Workbench communicates with Electron's main process via IPC channels using a binary protocol (varint-encoded messages with channel routing). The shim implements this full protocol and handles every channel:

| IPC Channel | Bridge | Description |
|---|---|---|
| `localPty` | WebSocket → PTY server | Terminal process management (create, input, resize, shutdown). Bridges to `adapter/pty-server.js` which uses `node-pty`. Also fires `onPtyHostStart` so the workbench knows the PTY host is alive. |
| `nativeHost` | Browser APIs | Window management, clipboard, dialogs, OS info. Uses `window.open`, `navigator.clipboard`, `window.prompt` etc. |
| `sign` | vsda WASM | Connection signing handshake. Loads `vsda_bg.wasm` for validator/sign operations. |
| `storage` | localStorage | Persistent key-value storage. Prefixed `cursor-web-storage:` keys. |
| `localFilesystem` | Fake FS | Returns directory stats for `.cursor/` paths, FileNotFound for files (VS Code uses defaults). Write operations silently succeed. |
| `extensionHostStarter` | Stub | Returns fake IDs. The real extension host runs server-side via the remote connection. |
| `keyboardLayout` | Static | Returns keyboard layout info (configurable). |
| `workspaces` | Stub | Returns empty recently-opened list. |
| `extensions` | Stub | Returns empty control manifest. Real extensions load via remote extension host. |
| `userDataProfiles` | Stub | Returns empty profile list. |
| `update` | Stub | Returns idle state. |
| `logger`, `tracing`, `policy`, `abuse`, `tray` | Stub | Silently absorbed. |

The remote terminal backend (VS Code Web server's built-in terminal service over WebSocket) is the primary terminal path. The localPty bridge provides shell detection (`getDefaultSystemShell`, `getEnvironment`, `getProfiles`) and serves as a fallback.

### IPC binary protocol

Messages use varint-encoded serialization with typed tags:

- **Types**: Undefined(0), String(1), Buffer(2), VSBuffer(3), Array(4), Object(5), Int(6)
- **Protocol messages**: Request(100), Cancel(101), EventSubscribe(102), EventDispose(103), Initialize(200), ResponseSuccess(201), ResponseError(202), EventFire(300)
- **Flow**: Workbench sends `vscode:hello` → shim responds with Initialize → workbench sends channel requests → shim routes to handlers and responds

### MessagePort protocol

The workbench also uses MessagePort for shared process and extension host communication:

- **Shared process ports**: Full IPC binary protocol (same as above)
- **Extension host ports**: Simplified byte protocol (Ready=2, Initialized=1). Shim fakes the handshake so the workbench doesn't wait 60s for a local extension host process.

## Quick start

```bash
# Extract Cursor (downloads AppImage, extracts overlay assets)
scripts/extract-cursor.sh latest arm64   # or amd64

# Build VS Code Web + overlay Cursor
scripts/build.sh

# Run (PTY server on port+1, VS Code Web server on main port)
PTY_PORT=20001 node dist/adapter/pty-server.cjs &
node dist/out/server-main.js --host 0.0.0.0 --port 20000 --without-connection-token
```

Open `http://localhost:20000` in your browser. You'll see the Cursor login page. Log in with your Cursor account, or click "Skip Login" to use without AI features.

## Directory structure

```
cursor-web/
  vscode/              VS Code OSS (git submodule)
  adapter/
    shim.js            IPC bridge — Electron to browser + VS Code Web backend
    pty-server.js      WebSocket PTY server (node-pty, runs on port+1)
  patches/
    cursor-web.patch   TypeScript source patches for VS Code
  scripts/
    extract-cursor.sh  Download + extract Cursor AppImage
    build.sh           Build VS Code Web + overlay Cursor
    merge-product.py   Merge VS Code + Cursor product.json
  test/
    terminal-*.mjs     Terminal rendering verification tests
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
