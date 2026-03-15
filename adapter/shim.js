/*!--------------------------------------------------------
 * Cursor Web — desktop workbench in browser with IPC bridge
 * (build-from-source variant — loaded from out/vs/code/browser/workbench/shim.js)
 *--------------------------------------------------------*/

// === CORS Proxy — route ALL external fetch through same-origin /cors-proxy/ ===
// No allowlist. URL: /cors-proxy/HOST/path → https://HOST/path
{
    const _originalFetch = window.fetch;
    const _externalRe = /^https?:\/\/([^/]+)/;
    const _vsRemoteRe = /^vscode-remote:\/\/[^/]+(\/.*)$/;
    window.fetch = function(input, init) {
        let url = (input instanceof Request) ? input.url : String(input);
        const rm = url.match(_vsRemoteRe);
        if (rm) {
            const resourcePath = rm[1];
            const rewritten = window.location.origin + '/vscode-remote-resource?path=' + encodeURIComponent(resourcePath);
            input = (input instanceof Request) ? new Request(rewritten, input) : rewritten;
        }
        const m = url.match(_externalRe);
        if (m && !url.startsWith(window.location.origin)) {
            const targetHost = m[1];
            const pathStart = url.indexOf('/', url.indexOf('://') + 3);
            const pathAndQuery = pathStart > 0 ? url.substring(pathStart) : '/';
            const proxied = window.location.origin + '/cors-proxy/' + targetHost + pathAndQuery;
            if (input instanceof Request) {
                input = new Request(proxied, { method: input.method, headers: input.headers, body: input.body, credentials: input.credentials, redirect: input.redirect, referrer: input.referrer, signal: input.signal });
            } else {
                input = proxied;
            }
        }
        return _originalFetch.call(window, input, init);
    };
}

// === IPC Binary Protocol (varint-based, matching VS Code's MQ serialization) ===
// Tags: Undefined=0, String=1, Buffer=2, VSBuffer=3, Array=4, Object=5, Int=6, Uint8Array=7
const MQ = { Undefined: 0, String: 1, Buffer: 2, VSBuffer: 3, Array: 4, Object: 5, Int: 6, Uint8Array: 7 };
const _enc = new TextEncoder();
const _dec = new TextDecoder();

// Varint encoding (same as protobuf LEB128)
function varintSize(n) { if (n === 0) return 1; let s = 0; for (let v = n; v !== 0; v = v >>> 7) s++; return s; }
function writeVarint(n) {
    if (n === 0) return new Uint8Array([0]);
    const sz = varintSize(n);
    const buf = new Uint8Array(sz);
    for (let i = 0; n !== 0; i++) { buf[i] = n & 127; n = n >>> 7; if (n > 0) buf[i] |= 128; }
    return buf;
}
function readVarint(buf, offset) {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
        const b = buf[offset++];
        value |= (b & 127) << shift;
        if (!(b & 128)) break;
    }
    return { value, nextOffset: offset };
}

function concatBuffers(...bufs) {
    const total = bufs.reduce((s, b) => s + b.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const b of bufs) { result.set(b, offset); offset += b.byteLength; }
    return result;
}

// Write functions (tag byte + varint length + data)
function writeUndefined() { return new Uint8Array([MQ.Undefined]); }
function writeInt(value) { return concatBuffers(new Uint8Array([MQ.Int]), writeVarint(value)); }
function writeString(str) {
    const encoded = _enc.encode(str);
    return concatBuffers(new Uint8Array([MQ.String]), writeVarint(encoded.length), encoded);
}
function writeObject(obj) {
    const encoded = _enc.encode(JSON.stringify(obj));
    return concatBuffers(new Uint8Array([MQ.Object]), writeVarint(encoded.length), encoded);
}
function writeBuffer(data) {
    return concatBuffers(new Uint8Array([MQ.Buffer]), writeVarint(data.length), data);
}
function writeArray(items) {
    const serialized = items.map(serializeValue);
    return concatBuffers(new Uint8Array([MQ.Array]), writeVarint(items.length), ...serialized);
}

// Read functions
function readValue(buf, offset) {
    if (offset >= buf.length) return { value: undefined, nextOffset: offset };
    const tag = buf[offset++];
    switch (tag) {
        case MQ.Undefined: return { value: undefined, nextOffset: offset };
        case MQ.Int: return readVarint(buf, offset);
        case MQ.String: {
            const { value: len, nextOffset: o } = readVarint(buf, offset);
            return { value: _dec.decode(buf.slice(o, o + len)), nextOffset: o + len };
        }
        case MQ.Buffer: case MQ.VSBuffer: case MQ.Uint8Array: {
            const { value: len, nextOffset: o } = readVarint(buf, offset);
            return { value: buf.slice(o, o + len), nextOffset: o + len };
        }
        case MQ.Object: {
            const { value: len, nextOffset: o } = readVarint(buf, offset);
            const str = _dec.decode(buf.slice(o, o + len));
            try { return { value: JSON.parse(str), nextOffset: o + len }; }
            catch { return { value: str, nextOffset: o + len }; }
        }
        case MQ.Array: {
            const { value: len, nextOffset: o } = readVarint(buf, offset);
            const arr = []; let pos = o;
            for (let i = 0; i < len; i++) { const r = readValue(buf, pos); arr.push(r.value); pos = r.nextOffset; }
            return { value: arr, nextOffset: pos };
        }
        default: return { value: undefined, nextOffset: offset };
    }
}

function serializeValue(v) {
    if (v === undefined) return writeUndefined();
    if (v === null) return writeUndefined();  // null → undefined in this protocol
    if (typeof v === 'boolean') return writeInt(v ? 1 : 0);
    if (typeof v === 'number') return writeInt(v);
    if (typeof v === 'string') return writeString(v);
    if (v instanceof Uint8Array) return writeBuffer(v);
    if (Array.isArray(v)) return writeArray(v);
    if (typeof v === 'object') return writeObject(v);
    return writeUndefined();
}

const ProtoType = {
    Request: 100, Cancel: 101, EventSubscribe: 102, EventDispose: 103,
    Initialize: 200, ResponseSuccess: 201, ResponseError: 202, EventFire: 300
};

// Protocol format: serialize(headerArray), serialize(body)
// Request header: [type, id, channelName, name], arg
// Response header: [type, id], data
// Init header: [type], undefined
function parseMessage(buf) {
    const headerR = readValue(buf, 0);
    const bodyR = readValue(buf, headerR.nextOffset);
    const header = headerR.value;
    if (!Array.isArray(header)) return null;
    return { type: header[0], id: header[1], channelName: header[2], name: header[3], arg: bodyR.value };
}

function buildResponse(type, id, data) {
    return concatBuffers(serializeValue([type, id]), serializeValue(data));
}

function buildInit() {
    return concatBuffers(serializeValue([ProtoType.Initialize]), writeUndefined());
}

function handleProtocolMessage(buf, respond) {
    const msg = parseMessage(buf);
    if (!msg) {
        showStatus?.(`[IPC] Unparseable message (${buf.length}B)`);
        return;
    }
    const { type, id, channelName, name, arg } = msg;

    if (type === ProtoType.Request) {
        const argStr = arg !== undefined ? JSON.stringify(arg)?.slice(0, 120) : '';
        showStatus?.(`[IPC] req ${channelName}.${name} id=${id} ${argStr}`);
        try {
            const result = handleChannelRequest(channelName, name, arg);
            respond(buildResponse(ProtoType.ResponseSuccess, id, result));
        } catch(e) {
            showStatus?.(`[IPC] ERROR ${channelName}.${name}: ${e.message}`);
            respond(buildResponse(ProtoType.ResponseError, id, { message: e.message, name: e.name }));
        }
    } else if (type === ProtoType.Cancel || type === ProtoType.EventDispose) {
        // Nothing to do
    } else if (type === ProtoType.EventSubscribe) {
        showStatus?.(`[IPC] eventSub ${channelName}.${name} id=${id}`);
    } else if (type === ProtoType.Initialize) {
        // Workbench sending init — ignore
    } else {
        showStatus?.(`[IPC] unhandled type=${type}`);
    }
}

// === Channel Handlers ===
// These are IPC channels the desktop workbench expects from the Electron main process.
// The remote serve-web server provides SEPARATE services over WebSocket (file system,
// terminal, extension host, search, etc.) — those are NOT these channels.
// We must stub all main-process IPC channels so the workbench doesn't hang.
function handleChannelRequest(channelName, methodName, arg) {
    switch (channelName) {
        case 'nativeHost': return handleNativeHost(methodName, arg);
        case 'sign': return handleSign(methodName, arg);
        case 'storage': return handleStorage(methodName, arg);
        case 'keyboardLayout': return handleKeyboardLayout(methodName);
        case 'policy': return (methodName === 'getPolicyDefinitions' || methodName === 'getPolicies') ? {} : undefined;
        case 'logger': return undefined;
        case 'tracing': return undefined;
        case 'abuse': return (methodName === 'getMachineId' || methodName === 'getMacMachineId') ? '' : undefined;
        case 'update': return (methodName === '_getInitialState') ? { type: 'idle' } : undefined;
        case 'tray': return undefined;
        case 'externalTerminal': return (methodName === 'getDefaultTerminalForPlatforms') ? {} : undefined;
        case 'agentAnalyticsOperations': return undefined;
        // Local filesystem — main process reads local config files.
        // In browser, these don't exist locally. Throw FileNotFound so VS Code uses defaults.
        case 'localFilesystem': return handleLocalFilesystem(methodName, arg);
        // Recently opened workspaces — main process concern, return empty
        case 'workspaces': return (methodName === 'getRecentlyOpened') ? { workspaces: [], files: [] } : undefined;
        // User profiles — main process concern, return empty defaults
        case 'userDataProfiles':
            if (methodName === 'getProfiles') return [];
            if (methodName === '_getInitialData') return { profiles: [], defaultProfile: null };
            return undefined;
        // Extensions control manifest — main process downloads this, stub empty
        case 'extensions':
            if (methodName === 'getExtensionsControlManifest') return { malicious: [], deprecated: {}, search: [], publisherMappings: {} };
            // getInstalled etc. — the remote server's extension host handles actual extensions
            return [];
        case 'extensionGalleryManifest': return undefined;
        // Extension host starter — main process launches extension host process.
        // In serve-web, the server runs the remote extension host. We return a stub
        // for the local extension host so the workbench doesn't crash.
        case 'extensionHostStarter': return handleExtensionHostStarter(methodName, arg);
        // File watcher — main process watches local files. In serve-web, server does this.
        case 'watcher': return undefined;
        // Utility process workers — main process concern
        case 'utilityProcessWorker': return undefined;
        // User data sync
        case 'userDataSyncAccount': return (methodName === '_getInitialData') ? { account: undefined } : undefined;
        case 'userDataSyncStoreManagement': return undefined;
        case 'userDataSync': return (methodName === '_getInitialData') ? { version: 1, machineId: '', enabledExtensions: [], enabledResources: [] } : undefined;
        // Local PTY — main process manages local terminals, remote server has its own
        case 'localPty': return (methodName === 'getPerformanceMarks') ? [] : undefined;
        // Path inspection — desktop checks if executables exist locally
        case 'pathInspection': return false;
        // Continuous profiling
        case 'continuousProfiling': return undefined;
        default:
            showStatus?.(`[IPC] unhandled channel: ${channelName}.${methodName}`);
            return undefined;
    }
}

// Local filesystem: the desktop workbench reads local config files via this IPC channel.
// In browser mode, we fake directory stats so the workbench can create its folder structure,
// and throw FileNotFound for files so VS Code uses defaults.
// The REMOTE filesystem (workspace files) is handled by the serve-web server over WebSocket.
function handleLocalFilesystem(method, arg) {
    const uri = Array.isArray(arg) ? arg[0] : arg;
    const path = uri?.path || '';

    if (method === 'stat') {
        const basename = path.split('/').pop() || '';
        const hasExtension = basename.includes('.');
        const isUnderCursor = path.includes('/.cursor/');

        // Well-known directory paths
        if (path === _homeDir || path === '/home' || path === '/' ||
            path.endsWith('/.cursor') || path.endsWith('/globalStorage') ||
            path.endsWith('/logs') || path.endsWith('/profiles') ||
            path.endsWith('/snippets') || path.endsWith('/prompts') ||
            path.endsWith('/cache')) {
            return { type: 2, ctime: Date.now(), mtime: Date.now(), size: 0 };
        }
        // Paths under .cursor/ — only pretend subdirectories exist.
        // Files should be FileNotFound so createFile can create them.
        if (isUnderCursor && !hasExtension) {
            return { type: 2, ctime: Date.now(), mtime: Date.now(), size: 0 };
        }
        // Everything else: not found
        const err = new Error('FileNotFound');
        err.name = 'EntryNotFound (FileSystemError)';
        err.code = 'FileNotFound';
        throw err;
    }
    if (method === 'readFile') {
        const err = new Error('FileNotFound');
        err.name = 'EntryNotFound (FileSystemError)';
        err.code = 'FileNotFound';
        throw err;
    }
    if (method === 'readdir') {
        return []; // Empty directory listing
    }
    // Write operations — return appropriate stat so the workbench thinks they succeeded
    if (method === 'createFile' || method === 'writeFile') {
        // Return file stat (type 1 = File)
        return { type: 1, ctime: Date.now(), mtime: Date.now(), size: 0 };
    }
    if (method === 'mkdir') {
        return { type: 2, ctime: Date.now(), mtime: Date.now(), size: 0 };
    }
    // delete, rename, watch — silently succeed
    return undefined;
}

// Extension host starter: the desktop workbench tries to start a LocalProcess extension host.
// We return a stub ID so it doesn't crash, but the process never actually starts.
// The remote server's extension host (started by serve-web) handles all extensions.
let _fakeExtHostId = 0;
function handleExtensionHostStarter(method, arg) {
    switch (method) {
        case 'createExtensionHost': return { id: String(++_fakeExtHostId) };
        case 'start': {
            // Return pid so the workbench doesn't crash destructuring.
            // The local extension host "starts" but won't do anything useful —
            // the remote extension host (from serve-web) handles everything.
            return { pid: 0 };
        }
        case 'getInspectPort': return undefined;
        case 'kill': return undefined;
        default: return undefined;
    }
}

function handleNativeHost(method, arg) {
    switch (method) {
        case 'getWindowCount': return 1;
        case 'getWindows': return [{ id: 1, workspace: undefined, title: 'Cursor Web' }];
        case 'isMaximized': return false;
        case 'isFullScreen': return false;
        case 'hasFocus': return document.hasFocus();
        case 'getOSProperties': return { arch: 'arm64', platform: 'linux', release: 'web', hostname: 'localhost', type: 'Linux' };
        case 'getOSStatistics': return { totalmem: 8589934592, freemem: 4294967296 };
        case 'getOSVirtualMachineHint': return 0;
        case 'getOSColorScheme': return { dark: true, highContrast: false };
        case 'hasWSLFeatureInstalled': return false;
        case 'getProcessId': return 1;
        case 'resolveProxy': return undefined;
        case 'readClipboardText': return '';
        case 'readClipboardFindText': return '';
        case 'readClipboardBuffer': return new Uint8Array(0);
        case 'showMessageBox': {
            const opts = Array.isArray(arg) ? arg[1] : arg;
            if (opts?.detail) {
                const urlMatch = opts.detail.match(/https?:\/\/\S+/);
                if (urlMatch) window.open(urlMatch[0], '_blank');
            }
            return { response: 0, checkboxChecked: false };
        }
        case 'showOpenDialog': {
            const opts = Array.isArray(arg) ? arg[1] : arg;
            const label = opts?.title || 'Enter folder path to open';
            const path = window.prompt(label, _homeDir);
            if (path) return { canceled: false, filePaths: [path] };
            return { canceled: true, filePaths: [] };
        }
        case 'showSaveDialog': return { canceled: true };
        case 'openExternal': {
            const url = Array.isArray(arg) ? arg[0] : arg;
            if (url) window.open(url, '_blank');
            return true;
        }
        case 'openWindow': {
            // Desktop workbench calls openWindow after showOpenDialog to open a folder/file.
            // IPC arg = [windowId, [{folderUri: URI}, ...], {forceNewWindow: bool, ...}]
            const items = Array.isArray(arg) ? arg[1] : [];
            const opts = Array.isArray(arg) ? arg[2] : {};
            if (Array.isArray(items) && items.length > 0) {
                const item = items[0];
                // Extract path from URI object ({$mid, scheme, path, ...}) or string
                const extractPath = (uri) => {
                    if (!uri) return '';
                    if (typeof uri === 'string') try { return new URL(uri).pathname; } catch { return uri; }
                    return uri.path || '';
                };
                const folderPath = extractPath(item.folderUri);
                const filePath = extractPath(item.fileUri);
                const wsPath = extractPath(item.workspaceUri);
                const target = folderPath || wsPath || filePath;
                if (target) {
                    showStatus?.(`openWindow: navigating to folder=${target}`);
                    if (opts?.forceNewWindow) {
                        window.open('/?folder=' + encodeURIComponent(target), '_blank');
                    } else {
                        window.location.href = '/?folder=' + encodeURIComponent(target);
                    }
                }
            }
            return undefined;
        }
        case 'focusWindow': case 'maximizeWindow': case 'minimizeWindow':
        case 'unmaximizeWindow': case 'setMinimumSize': case 'setTitle':
        case 'notifyReady': case 'updateWindowControls': case 'positionWindow':
        case 'installShellCommand': case 'writeClipboardText': case 'writeClipboardBuffer':
            return undefined;
        case 'isAdmin': return false;
        case 'getActiveWindowPosition': return { x: 0, y: 0, width: 1920, height: 1080 };
        case 'getCursorScreenPoint': return { x: 0, y: 0 };
        default: return undefined;
    }
}
// Sign service: uses vsda WASM for connection handshake
let _vsdaModule = null;
let _vsdaLoading = null;
let _vsdaValidators = new Map();
let _vsdaNextId = 1;

async function _loadVsda() {
    if (_vsdaModule) return _vsdaModule;
    if (_vsdaLoading) return _vsdaLoading;
    _vsdaLoading = (async () => {
        try {
            // vsda files are in the static output directory
            const staticBase = (globalThis._VSCODE_FILE_ROOT || '/out/').replace(/\/out\/$/, '');
            const wasmUrl = staticBase + '/node_modules/vsda/rust/web/vsda_bg.wasm';
            const jsUrl = staticBase + '/node_modules/vsda/rust/web/vsda.js';
            // Load the vsda JS (sets globalThis.vsda_web)
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = jsUrl;
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
            // Fetch WASM and init synchronously
            const wasmResp = await fetch(wasmUrl);
            const wasmBytes = await wasmResp.arrayBuffer();
            globalThis.vsda_web.initSync(wasmBytes);
            _vsdaModule = globalThis.vsda_web;
            showStatus?.('vsda WASM loaded for connection signing');
            return _vsdaModule;
        } catch (e) {
            showStatus?.('vsda WASM load failed: ' + e.message);
            return null;
        }
    })();
    return _vsdaLoading;
}

// Pre-load vsda
_loadVsda();

function handleSign(method, arg) {
    switch (method) {
        case 'createNewMessage': {
            const nonce = Array.isArray(arg) ? arg[0] : arg;
            if (_vsdaModule) {
                try {
                    const v = new _vsdaModule.validator();
                    const data = v.createNewMessage(nonce || '');
                    const id = String(_vsdaNextId++);
                    _vsdaValidators.set(id, v);
                    return { id, data };
                } catch (e) {
                    showStatus?.('vsda createNewMessage error: ' + e.message);
                }
            }
            return { id: '', data: nonce || '' };
        }
        case 'validate': {
            // arg = [{ id, data }, signedData]
            const msg = Array.isArray(arg) ? arg[0] : arg;
            const signedData = Array.isArray(arg) ? arg[1] : '';
            if (msg?.id && _vsdaValidators.has(msg.id)) {
                const v = _vsdaValidators.get(msg.id);
                _vsdaValidators.delete(msg.id);
                try {
                    const result = v.validate(signedData || '');
                    v.free();
                    return result === 'ok';
                } catch (e) {
                    v.free();
                    showStatus?.('vsda validate error: ' + e.message);
                }
            }
            return true;
        }
        case 'sign': {
            const value = Array.isArray(arg) ? arg[0] : (arg || '');
            if (_vsdaModule) {
                try { return _vsdaModule.sign(value); } catch {}
            }
            return value;
        }
        default: return undefined;
    }
}
// Storage: backed by localStorage, seeded from desktop Cursor's state.vscdb
const _storagePrefix = 'cursor-web-storage:';
function _storageGetAll() {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(_storagePrefix)) {
            items.push([k.slice(_storagePrefix.length), localStorage.getItem(k)]);
        }
    }
    return items;
}
// No storage write-protection needed — layout toggle happens post-boot.
function handleStorage(method, arg) {
    switch (method) {
        case 'getItems': return _storageGetAll();
        case 'updateItems': {
            if (arg?.insert) {
                for (const [k, v] of arg.insert) {
                    localStorage.setItem(_storagePrefix + k, v);
                }
            }
            if (arg?.delete) {
                for (const k of arg.delete) {
                    localStorage.removeItem(_storagePrefix + k);
                }
            }
            return undefined;
        }
        case 'optimize': case 'close': return undefined;
        case 'isUsed': return true;
        default: return undefined;
    }
}
function handleKeyboardLayout(method) {
    if (method === 'getKeyboardLayoutData' || method === 'getCurrentKeyboardLayoutData')
        return { keyboardLayoutInfo: { model: '', layout: 'de', variant: '', options: '', rules: '' }, keyboardMapping: {} };
    if (method === 'getCurrentKeyboardLayout')
        return { model: '', layout: 'de', variant: '', options: '', rules: '' };
    return undefined;
}

// === MessagePort Protocol Handler ===
// The shared process / utility worker uses the same binary protocol over MessagePort
function setupProtocolPort(port) {
    let state = 0; // 0=wait-handshake, 1=wait-first-msg, 2=running
    port.onmessage = (event) => {
        const raw = event.data;
        const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

        if (state === 0) {
            // First message is the handshake buffer (a serialized string like "window:1,module:vs...")
            // Respond with init, then wait for actual protocol messages
            state = 1;
            showStatus?.(`[Port] Handshake (${buf.length}B), sending init...`);
            const initBuf = buildInit();
            port.postMessage(initBuf);
            return;
        }
        if (state === 1) {
            state = 2;
            // Second message might be another init from the workbench — check and skip
            const msg = parseMessage(buf);
            if (msg && msg.type === ProtoType.Initialize) {
                showStatus?.('[Port] Got workbench init, ready.');
                return;
            }
            // Otherwise it's a real message, fall through
        }

        handleProtocolMessage(buf, (resp) => {
            port.postMessage(resp);
        });
    };
    port.start();
}

// === IPC Renderer ===
const _ipcListeners = new Map();
function _fire(channel, ...args) {
    for (const fn of (_ipcListeners.get(channel) || [])) {
        try { fn({}, ...args); } catch(e) { console.warn('[IPC] listener error:', e); }
    }
}

// === Config ===
// Read webConfig early so we can derive homeDir for use in globalThis.vscode and channel handlers
const configElement = document.getElementById('vscode-workbench-web-configuration');
const webConfig = JSON.parse(configElement?.getAttribute('data-settings') || '{}');

// Home directory: configurable via URL ?homeDir= or webConfig, defaults to /home/coder
const _homeDir = new URLSearchParams(window.location.search).get('homeDir') || webConfig.homeDir || '/home/coder';
const _dataDir = _homeDir + '/.cursor';

globalThis.vscode = {
    context: { configuration: () => ({ product: globalThis._VSCODE_PRODUCT_JSON || {} }) },
    ipcRenderer: {
        send(channel, ...args) {
            showStatus?.(`IPC.send: ${channel}`);
            if (channel === 'vscode:hello') {
                setTimeout(() => {
                    showStatus?.('Sending IPC init (type 200)...');
                    _fire('vscode:message', buildInit());
                    showStatus?.('IPC init sent.');
                }, 0);
                return;
            }
            if (channel === 'vscode:message') {
                const buf = new Uint8Array(args[0]);
                handleProtocolMessage(buf, (resp) => {
                    queueMicrotask(() => _fire('vscode:message', resp));
                });
                return;
            }
        },
        invoke(channel, ...args) {
            showStatus?.(`IPC.invoke: ${channel}`);
            if (channel === 'vscode:fetchShellEnvironment' || channel === 'vscode:getShellEnvironment')
                return Promise.resolve({});
            return Promise.resolve(undefined);
        },
        on(channel, fn) {
            showStatus?.(`IPC.on: ${channel}`);
            if (!_ipcListeners.has(channel)) _ipcListeners.set(channel, []);
            _ipcListeners.get(channel).push(fn);
            return { dispose() { const a = _ipcListeners.get(channel); if(a) { const i = a.indexOf(fn); if(i>=0) a.splice(i,1); } } };
        },
        once(channel, fn) {
            const wrapped = (...args) => { fn(...args); d.dispose(); };
            const d = globalThis.vscode.ipcRenderer.on(channel, wrapped);
            return d;
        },
        removeListener(channel, fn) {
            const a = _ipcListeners.get(channel);
            if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
        },
    },
    ipcMessagePort: {
        acquire(responseChannel, nonce) {
            showStatus?.(`IPC.port.acquire: ${responseChannel} nonce=${nonce}`);
            // The workbench listens on window "message" for { data: nonce, ports: [port], source: window }
            const mc = new MessageChannel();
            // Set up the port to handle the IPC protocol (init + channel requests)
            setupProtocolPort(mc.port2);
            setTimeout(() => {
                showStatus?.('Posting MessagePort via window.postMessage...');
                window.postMessage(nonce, '*', [mc.port1]);
            }, 0);
        },
    },
    webFrame: { setZoomLevel() {} },
    process: {
        platform: 'linux', arch: 'arm64', env: {},
        versions: { node: '20.0.0', chrome: '120.0.0', electron: '32.0.0' },
        type: 'renderer', sandboxed: true, cwd: () => _homeDir, pid: 1,
        on() {}, once() {}, removeListener() {}, emit() {},
        getHeapStatistics: () => ({}),
        getProcessMemoryInfo: () => Promise.resolve({ private: 0, shared: 0 }),
        shellEnv: () => Promise.resolve({}),
    },
};

// Extract commit hash from <base> tag URL (e.g. /stable-{commit}/static/...)
const _baseHref = document.querySelector('base')?.getAttribute('href') || '';
const _commitMatch = _baseHref.match(/\/\w+-([a-f0-9]{40})\//);
const _commit = _commitMatch ? _commitMatch[1] : '';

globalThis._VSCODE_PRODUCT_JSON = Object.assign({
    "quality": "stable", "licenseName": "MIT",
    "version": "2.6.19",
    "vscodeVersion": "1.105.1",
    "commit": _commit,
    "dataFolderName": ".cursor",
    "serverApplicationName": "cursor-server",
    "serverDataFolderName": ".cursor-server",
    "tunnelApplicationName": "cursor-tunnel",
    "urlProtocol": "cursor",
}, webConfig.productConfiguration || {});

globalThis._VSCODE_PACKAGE_JSON = {
    "name": "Cursor", "version": "2.6.19",
    "main": "./out/main.js", "type": "module", "private": true
};

// === Visible Status (console only) ===
function showStatus(msg) {
    console.warn('[CursorWeb] ' + msg);
}

// === Auth Token Seeding ===
async function seedAuthTokens() {
    // Clean up stale desktop keys that break web UI, but preserve layout state
    const _layoutKeepPrefixes = ['cursor/editorLayout.', 'cursor/agentLayout.', 'cursor/unifiedAppLayout',
        'cursor/layoutControl.', 'cursor/noTitlebarLayout.', 'cursor/migrateEditorMode.',
        'cursor/defaultLayoutMode', 'cursor/globalLayoutState'];
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(_storagePrefix + 'cursor/') || k?.startsWith(_storagePrefix + 'cursor.')) {
            const suffix = k.slice(_storagePrefix.length);
            if (_layoutKeepPrefixes.some(p => suffix.startsWith(p))) continue;
            localStorage.removeItem(k);
        }
    }
    // One-time layout reset: undo damage from migrate_editor_mode migration
    // (now disabled via workbench patch 7o) and prevent onboarding from forcing Agent mode.
    const _layoutFixVersion = '8';
    const _layoutFixKey = _storagePrefix + 'cursorWeb/layoutFixApplied';
    if (localStorage.getItem(_layoutFixKey) !== _layoutFixVersion) {
        // Reset Agent mode hidden flags
        for (const k of ['workbench.sideBar.hidden', 'workbench.auxiliaryBar.hidden',
            'workbench.activityBar.hidden', 'workbench.unifiedSidebar.hidden']) {
            localStorage.removeItem(_storagePrefix + k);
        }
        // Reset layout mode — default is M0.Editor ("editor")
        localStorage.removeItem(_storagePrefix + 'cursor/unifiedAppLayout');
        localStorage.removeItem(_storagePrefix + 'cursor/migrateEditorMode.forceUnified');
        // Don't skip onboarding — it contains the login UI
        localStorage.setItem(_layoutFixKey, _layoutFixVersion);
        showStatus('Layout reset applied (migration disabled, onboarding skipped).');
    }
    if (localStorage.getItem(_storagePrefix + 'cursorAuth/accessToken')) {
        showStatus('Auth tokens already in localStorage.');
        return;
    }
    try {
        // Auth seed file served from the server root
        const resp = await fetch('/cursor-auth-seed.json');
        if (!resp.ok) { showStatus('No auth seed file (run patch-cursor-web.sh).'); return; }
        const tokens = await resp.json();
        for (const [key, value] of Object.entries(tokens)) {
            localStorage.setItem(_storagePrefix + key, value);
        }
        showStatus('Auth tokens seeded: ' + Object.keys(tokens).join(', '));
    } catch (e) {
        showStatus('Auth seed fetch failed: ' + e.message);
    }
}

// === Boot ===
performance.mark('code/willLoadWorkbenchMain');

async function boot() {
    try {
        await seedAuthTokens();
        await _loadVsda();
        showStatus('Loading desktop workbench...');
        // Import the desktop workbench main module — relative path resolves from
        // out/vs/code/browser/workbench/ to out/vs/workbench/workbench.desktop.main.js
        const workbench = await import('../../../workbench/workbench.desktop.main.js');
        performance.mark('code/didLoadWorkbenchMain');
        showStatus('Desktop workbench loaded. Exports: ' + Object.keys(workbench).join(', '));

        const authority = webConfig.remoteAuthority || window.location.host;
        const makeUri = (path) => ({ scheme: 'vscode-remote', authority, path });

        // Read workspace from URL query params (same as web workbench)
        const params = new URLSearchParams(window.location.search);
        const folderParam = params.get('folder');
        const workspaceParam = params.get('workspace');
        let workspace = undefined;
        if (folderParam) {
            // Single folder workspace: K1c() revives { id, uri } via je.revive()
            workspace = { id: crypto.randomUUID(), uri: { scheme: 'vscode-remote', authority, path: folderParam } };
        } else if (workspaceParam) {
            // Multi-root workspace: K1c() revives { id, configPath } via je.revive()
            workspace = { id: crypto.randomUUID(), configPath: { scheme: 'vscode-remote', authority, path: workspaceParam } };
        }

        const desktopConfig = {
            windowId: 1,
            machineId: 'web-' + (localStorage.getItem('cursor-mid') || (() => { const id = crypto.randomUUID(); localStorage.setItem('cursor-mid', id); return id; })()),
            sqmId: '', devDeviceId: '',
            remoteAuthority: authority,
            appRoot: '/', execPath: '/cursor',
            homeDir: _homeDir,
            tmpDir: '/tmp',
            userDataDir: _dataDir,
            backupPath: '',
            isInitialStartup: !localStorage.getItem('cursor-init'),
            workspace,
            fullscreen: false, maximized: false, glass: false,
            colorScheme: { dark: window.matchMedia('(prefers-color-scheme: dark)').matches, highContrast: false },
            autoDetectColorScheme: true, autoDetectHighContrast: true,
            nls: { messages: globalThis._VSCODE_NLS_MESSAGES || [], language: navigator.language?.split('-')[0] || 'en' },
            profiles: {
                home: makeUri(_dataDir),
                profile: {
                    id: '__default__', isDefault: true, name: 'Default', icon: undefined,
                    location: makeUri(_dataDir + '/profiles'),
                    globalStorageHome: makeUri(_dataDir + '/globalStorage'),
                    settingsResource: makeUri(_dataDir + '/settings.json'),
                    keybindingsResource: makeUri(_dataDir + '/keybindings.json'),
                    tasksResource: makeUri(_dataDir + '/tasks.json'),
                    snippetsHome: makeUri(_dataDir + '/snippets'),
                    promptsHome: makeUri(_dataDir + '/prompts'),
                    extensionsResource: makeUri(_dataDir + '/extensions.json'),
                    cacheHome: makeUri(_dataDir + '/cache'),
                    useDefaultFlags: undefined, isTransient: false
                },
                all: [{
                    id: '__default__', isDefault: true, name: 'Default', icon: undefined,
                    location: makeUri(_dataDir + '/profiles'),
                    globalStorageHome: makeUri(_dataDir + '/globalStorage'),
                    settingsResource: makeUri(_dataDir + '/settings.json'),
                    keybindingsResource: makeUri(_dataDir + '/keybindings.json'),
                    tasksResource: makeUri(_dataDir + '/tasks.json'),
                    snippetsHome: makeUri(_dataDir + '/snippets'),
                    promptsHome: makeUri(_dataDir + '/prompts'),
                    extensionsResource: makeUri(_dataDir + '/extensions.json'),
                    cacheHome: makeUri(_dataDir + '/cache'),
                    useDefaultFlags: undefined, isTransient: false
                }]
            },
            os: { release: 'web' },
            mainPid: 0, logLevel: 3, loggers: [],
            product: globalThis._VSCODE_PRODUCT_JSON,
            perfMarks: performance.getEntriesByType('mark').map(m => ({
                name: m.name, startTime: Math.round(performance.timeOrigin + m.startTime)
            }))
        };

        localStorage.setItem('cursor-init', '1');
        showStatus('Calling workbench.main()...');
        const result = workbench.main(desktopConfig);
        showStatus('workbench.main() returned: ' + typeof result);
        // Note: onboarding overlay is NOT auto-dismissed — it contains the login UI
        if (result?.then) {
            result.then(() => showStatus('Promise resolved — workbench started.'))
                  .catch(e => showStatus('Promise rejected: ' + e + '\nStack: ' + (e?.stack || 'none')));
        }
    } catch (err) {
        console.error('[CursorWeb] Boot failed:', err);
        document.body.innerHTML = `
            <div style="padding:40px;font-family:system-ui;color:#ccc;background:#1e1e1e;min-height:100vh">
                <h1 style="color:#fff">Cursor Web — Error</h1>
                <pre style="color:#f88;white-space:pre-wrap;max-width:90vw;overflow:auto">${err.stack || err}</pre>
            </div>`;
    }
}

boot();
