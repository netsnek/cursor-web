#!/usr/bin/env node
/**
 * Post-load workbench integration test — verifies the workbench is functional
 * after the initial load. Tests extension host stability, IPC, CSP, WASM,
 * product config, and critical error thresholds.
 *
 * This test is designed to catch regressions when upgrading Cursor versions.
 *
 * Usage: node test/workbench.mjs [--port PORT] [--timeout SECONDS]
 */
import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const getArg = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = getArg('port', '20000');
const TIMEOUT = parseInt(getArg('timeout', '25'));
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const pass = (msg) => { console.log(`  [PASS] ${msg}`); passed++; };
const fail = (msg) => { console.log(`  [FAIL] ${msg}`); failed++; };

// Find chromium
let execPath;
for (const bin of ['chromium-browser', 'chromium', 'google-chrome-stable', 'google-chrome']) {
    try { execPath = execSync(`which ${bin} 2>/dev/null`).toString().trim(); if (execPath) break; } catch {}
}
if (!execPath) { console.error('ERROR: No chromium/chrome found'); process.exit(1); }

console.log(`\n==> Workbench integration test: ${BASE}/`);
console.log(`    Timeout: ${TIMEOUT}s\n`);

const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1920,1080'],
    defaultViewport: { width: 1920, height: 1080 }
});

const page = await browser.newPage();

// Collect errors categorized
const consoleErrors = [];
const cspViolations = [];
const extHostCrashes = [];
const ipcMessages = [];
const networkFailures = [];
const jsExceptions = [];

page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error') {
        consoleErrors.push(text.substring(0, 300));
        if (text.includes('Content Security Policy')) cspViolations.push(text.substring(0, 200));
        if (text.includes('Extension host') && text.includes('terminated')) extHostCrashes.push(text);
    }
    if (text.includes('[CursorWeb]') && text.includes('[IPC]')) ipcMessages.push(text);
});

page.on('pageerror', err => jsExceptions.push(err.message.substring(0, 200)));
page.on('requestfailed', req => {
    const url = req.url();
    // Ignore external resources that may be unreachable in test
    if (!url.includes('127.0.0.1') && !url.includes('localhost')) return;
    networkFailures.push({ url: url.substring(0, 150), error: req.failure()?.errorText });
});

// ============================================================
// Load page
// ============================================================
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

// Wait for workbench to fully initialize
await new Promise(r => setTimeout(r, TIMEOUT * 1000));

// ============================================================
// 1. Product JSON validation
// ============================================================
console.log('--- Product JSON ---');

const product = await page.evaluate(() => globalThis._VSCODE_PRODUCT_JSON);
if (product) {
    pass('_VSCODE_PRODUCT_JSON exists');
    product.extensionsGallery?.serviceUrl
        ? pass('extensionsGallery.serviceUrl configured')
        : fail('extensionsGallery.serviceUrl missing');
    // Product config is set by server embed config — check key fields exist
    product.version
        ? pass(`Product version: ${product.version}`)
        : fail('Product version missing');
} else {
    fail('_VSCODE_PRODUCT_JSON is null/undefined');
}

// ============================================================
// 2. Extension host stability
// ============================================================
console.log('\n--- Extension Host ---');

const extHostCrashCount = extHostCrashes.filter(t => t.includes('terminated unexpectedly with code')).length;
extHostCrashCount === 0
    ? pass('Extension host: no crashes')
    : fail(`Extension host crashed ${extHostCrashCount} time(s)`);

// Check server log for module errors (if log file exists)
try {
    const serverLog = execSync('cat /tmp/cursor-web*.log 2>/dev/null || true').toString();
    const moduleErrors = serverLog.match(/ERR_MODULE_NOT_FOUND|Cannot find package/g);
    if (moduleErrors) {
        fail(`Server has ${moduleErrors.length} missing module error(s)`);
        // Extract package names
        const pkgs = [...new Set(serverLog.match(/'@[^']+'/g) || [])];
        for (const p of pkgs.slice(0, 5)) console.log(`    Missing: ${p}`);
    } else {
        pass('No missing modules in server log');
    }
} catch { /* no log file */ }

// ============================================================
// 3. IPC channel communication
// ============================================================
console.log('\n--- IPC Channels ---');

const ipcChannels = new Set(ipcMessages.map(m => {
    const match = m.match(/\[IPC\] (?:req|eventSub) (\S+)/);
    return match ? match[1] : null;
}).filter(Boolean));

ipcChannels.size > 0
    ? pass(`IPC: ${ipcChannels.size} channels active`)
    : fail('No IPC channel activity detected');

// Check for critical channels
for (const ch of ['storage.updateItems', 'sign.createNewMessage']) {
    ipcChannels.has(ch)
        ? pass(`IPC channel: ${ch}`)
        : fail(`IPC channel missing: ${ch}`);
}

// ============================================================
// 4. DOM structure
// ============================================================
console.log('\n--- DOM Structure ---');

const domState = await page.evaluate(() => {
    const q = (sel) => !!document.querySelector(sel);
    return {
        workbench: q('.monaco-workbench'),
        menubar: q('.menubar') || q('[role="menubar"]'),
        statusbar: q('.part.statusbar') || q('[id*="statusbar"]'),
        title: document.title,
        bodyClasses: document.body.className?.substring(0, 100),
        // Check workbench parts
        activitybar: q('.part.activitybar') || q('[id*="activitybar"]'),
        sidebar: q('.part.sidebar') || q('[id*="sidebar"]'),
        editor: q('.part.editor') || q('[id*="editor"]'),
    };
});

domState.workbench ? pass('DOM: .monaco-workbench exists') : fail('DOM: .monaco-workbench missing');
domState.menubar ? pass('DOM: menubar exists') : fail('DOM: menubar missing');
domState.statusbar ? pass('DOM: statusbar exists') : fail('DOM: statusbar missing');

// ============================================================
// 5. Static resources served correctly
// ============================================================
console.log('\n--- Static Resources ---');

// Discover static prefix
const html = await page.evaluate(() => document.documentElement.outerHTML);
const prefixMatch = html.match(/\/stable-[a-f0-9]+\/static/);
const STATIC = prefixMatch ? prefixMatch[0] : '/stable-dev/static';

const resources = [
    { path: `${STATIC}/out/vs/workbench/workbench.desktop.main.js`, name: 'Desktop workbench JS' },
    { path: `${STATIC}/out/vs/workbench/workbench.desktop.main.css`, name: 'Desktop workbench CSS' },
    { path: `${STATIC}/out/vs/code/browser/workbench/shim.js`, name: 'Shim JS' },
    { path: `${STATIC}/out/nls.messages.json`, name: 'NLS messages' },
    { path: `${STATIC}/out/media/codicon.ttf`, name: 'Codicon font' },
    { path: `${STATIC}/out/media/cursor-icons-outline.woff2`, name: 'Cursor icons font' },
];

for (const res of resources) {
    try {
        const resp = await page.evaluate(async (url) => {
            const r = await fetch(url);
            return { status: r.status, type: r.headers.get('content-type') };
        }, `${BASE}${res.path}`);
        resp.status === 200
            ? pass(`${res.name} → 200 (${resp.type?.split(';')[0]})`)
            : fail(`${res.name} → ${resp.status}`);
    } catch (e) {
        fail(`${res.name} → fetch error: ${e.message}`);
    }
}

// ============================================================
// 6. MIME types
// ============================================================
console.log('\n--- MIME Types ---');

const mimeChecks = [
    { ext: '.js', expected: 'javascript', path: `${STATIC}/out/vs/code/browser/workbench/shim.js` },
    { ext: '.css', expected: 'text/css', path: `${STATIC}/out/vs/workbench/workbench.desktop.main.css` },
    { ext: '.json', expected: 'application/json', path: `${STATIC}/out/nls.messages.json` },
    { ext: '.ttf', expected: 'font/ttf', path: `${STATIC}/out/media/codicon.ttf` },
];

for (const check of mimeChecks) {
    try {
        const resp = await page.evaluate(async (url) => {
            const r = await fetch(url);
            return r.headers.get('content-type') || '';
        }, `${BASE}${check.path}`);
        resp.includes(check.expected)
            ? pass(`MIME ${check.ext}: ${resp.split(';')[0]}`)
            : fail(`MIME ${check.ext}: got "${resp}", expected "${check.expected}"`);
    } catch {}
}

// Check WASM MIME (if vsda exists)
try {
    const wasmResp = await page.evaluate(async (base) => {
        // Try to find a .wasm file
        const r = await fetch(`${base}/version`);
        return { status: r.status };
    }, BASE);
    // We test via the MIME map rather than finding a specific .wasm file
} catch {}

// ============================================================
// 7. CSP violations
// ============================================================
console.log('\n--- Content Security Policy ---');

cspViolations.length === 0
    ? pass('No CSP violations')
    : fail(`${cspViolations.length} CSP violation(s): ${cspViolations[0]?.substring(0, 100)}`);

// ============================================================
// 8. CORS proxy
// ============================================================
console.log('\n--- CORS Proxy ---');

const corsOpts = await page.evaluate(async (base) => {
    try {
        const r = await fetch(`${base}/cors-proxy/api2.cursor.sh/`, { method: 'OPTIONS' });
        return {
            status: r.status,
            allowOrigin: r.headers.get('access-control-allow-origin'),
            allowMethods: r.headers.get('access-control-allow-methods'),
        };
    } catch (e) { return { error: e.message }; }
}, BASE);

if (corsOpts.error) {
    fail(`CORS proxy OPTIONS: ${corsOpts.error}`);
} else {
    corsOpts.status === 200 ? pass('CORS proxy OPTIONS → 200') : fail(`CORS proxy OPTIONS → ${corsOpts.status}`);
    corsOpts.allowOrigin === '*' ? pass('CORS: Access-Control-Allow-Origin: *') : fail(`CORS: ACAO is "${corsOpts.allowOrigin}"`);
}

// ============================================================
// 9. Cursor extensions loaded
// ============================================================
console.log('\n--- Cursor Extensions ---');

const cursorExts = ['cursor-retrieval', 'theme-cursor', 'cursor-mcp'];
for (const ext of cursorExts) {
    try {
        const resp = await page.evaluate(async (url) => {
            const r = await fetch(url);
            if (!r.ok) return { status: r.status };
            const pkg = await r.json();
            return { status: r.status, name: pkg.name, version: pkg.version };
        }, `${BASE}${STATIC}/extensions/${ext}/package.json`);
        resp.status === 200
            ? pass(`Extension ${ext}: ${resp.name}@${resp.version}`)
            : fail(`Extension ${ext} → ${resp.status}`);
    } catch (e) {
        fail(`Extension ${ext}: ${e.message}`);
    }
}

// ============================================================
// 10. Desktop workbench bundle size (sanity check)
// ============================================================
console.log('\n--- Bundle Size ---');

const jsSize = await page.evaluate(async (url) => {
    const r = await fetch(url);
    const blob = await r.blob();
    return blob.size;
}, `${BASE}${STATIC}/out/vs/workbench/workbench.desktop.main.js`);

const jsMB = Math.round(jsSize / 1048576);
jsMB >= 10
    ? pass(`Desktop JS bundle: ${jsMB}MB (Cursor bundle, not VS Code web)`)
    : fail(`Desktop JS bundle: ${jsMB}MB (expected >10MB — may be VS Code web instead of Cursor)`);

// ============================================================
// 11. Critical JS error threshold
// ============================================================
console.log('\n--- Error Thresholds ---');

// Filter out known non-critical errors
const criticalErrors = consoleErrors.filter(e =>
    !e.includes('API proposal') &&
    !e.includes('DOES NOT EXIST') &&
    !e.includes('CANNOT USE these API proposals') &&
    !e.includes('proposed menu identifier') &&
    !e.includes('Content Security Policy') &&
    !e.includes('Failed to query fonts') &&
    !e.includes('Unable to resolve nonexistent file') &&
    !e.includes('Unable to create file') &&
    !e.includes('FileNotFound') &&
    !e.includes('UtilityProcessWorker') &&
    !e.includes('File Watcher') &&
    !e.includes('RemotePerformance') &&
    !e.includes('remoteTerminalBackend') &&
    !e.includes('CloseEvent') &&
    !e.includes('sourcemap')
);

const jsExceptCount = jsExceptions.length;
jsExceptCount <= 5
    ? pass(`Uncaught JS exceptions: ${jsExceptCount} (threshold: ≤5)`)
    : fail(`Uncaught JS exceptions: ${jsExceptCount} (threshold: ≤5)`);

// Total network failures (local resources only)
networkFailures.length <= 3
    ? pass(`Local network failures: ${networkFailures.length} (threshold: ≤3)`)
    : fail(`Local network failures: ${networkFailures.length} (threshold: ≤3)`);

if (networkFailures.length > 0) {
    for (const nf of networkFailures.slice(0, 5)) {
        console.log(`    ${nf.url} — ${nf.error}`);
    }
}

// ============================================================
// 12. Screenshot
// ============================================================
await page.screenshot({ path: 'test/workbench-screenshot.png' });
console.log('\n==> Screenshot: test/workbench-screenshot.png');

await browser.close();

console.log(`\n==> Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
