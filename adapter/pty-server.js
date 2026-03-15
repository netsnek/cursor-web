/*!
 * Cursor Web — standalone WebSocket PTY server
 * Runs alongside VS Code Web server on port+1.
 * The shim connects to this for terminal operations.
 */
const WebSocket = require('ws');
const pty = require('node-pty');
const os = require('os');

const PORT = parseInt(process.env.PTY_PORT || '0');
if (!PORT) { console.error('PTY_PORT not set'); process.exit(1); }

let nextPtyId = 1;
const ptys = new Map();

const wss = new WebSocket.Server({ port: PORT, host: '0.0.0.0' });

wss.on('listening', () => {
    console.log(`[pty-server] WebSocket PTY server listening on port ${PORT}`);
});

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            handleMessage(ws, msg);
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', error: e.message }));
        }
    });
    ws.on('close', () => {
        for (const [id, entry] of ptys) {
            const idx = entry.clients.indexOf(ws);
            if (idx >= 0) entry.clients.splice(idx, 1);
            if (entry.clients.length === 0 && entry.ownerWs === ws) {
                entry.process.kill();
                ptys.delete(id);
            }
        }
    });
    ws.send(JSON.stringify({ type: 'ready' }));
});

function handleMessage(ws, msg) {
    switch (msg.type) {
        case 'create': {
            const id = nextPtyId++;
            const shell = msg.shell || process.env.SHELL || '/bin/bash';
            const cwd = msg.cwd || os.homedir();
            const cols = msg.cols || 80;
            const rows = msg.rows || 24;
            const env = { ...process.env, ...(msg.env || {}), TERM: 'xterm-256color' };

            const proc = pty.spawn(shell, msg.args || [], {
                name: 'xterm-256color', cols, rows, cwd, env,
            });

            const entry = { process: proc, clients: [ws], ownerWs: ws, shell };
            ptys.set(id, entry);

            proc.onData((data) => {
                for (const c of entry.clients) {
                    if (c.readyState === WebSocket.OPEN) {
                        c.send(JSON.stringify({ type: 'data', id, data }));
                    }
                }
            });
            proc.onExit(({ exitCode, signal }) => {
                for (const c of entry.clients) {
                    if (c.readyState === WebSocket.OPEN) {
                        c.send(JSON.stringify({ type: 'exit', id, exitCode, signal }));
                    }
                }
                ptys.delete(id);
            });

            ws.send(JSON.stringify({ type: 'created', id, pid: proc.pid, cwd }));
            break;
        }
        case 'input': {
            const e = ptys.get(msg.id);
            if (e) e.process.write(msg.data);
            break;
        }
        case 'resize': {
            const e = ptys.get(msg.id);
            if (e) try { e.process.resize(msg.cols, msg.rows); } catch {}
            break;
        }
        case 'shutdown': {
            const e = ptys.get(msg.id);
            if (e) { e.process.kill(); ptys.delete(msg.id); }
            break;
        }
        case 'getDefaultSystemShell':
            ws.send(JSON.stringify({ type: 'response', reqId: msg.reqId, data: process.env.SHELL || '/bin/bash' }));
            break;
        case 'getEnvironment':
            ws.send(JSON.stringify({ type: 'response', reqId: msg.reqId, data: process.env }));
            break;
        case 'getProfiles':
            ws.send(JSON.stringify({
                type: 'response', reqId: msg.reqId,
                data: [{ profileName: 'bash', path: process.env.SHELL || '/bin/bash', isDefault: true }],
            }));
            break;
        default:
            if (msg.reqId) ws.send(JSON.stringify({ type: 'response', reqId: msg.reqId, data: undefined }));
    }
}
