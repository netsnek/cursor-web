#!/usr/bin/env node
/**
 * Headless browser test — loads Cursor Web and captures console output,
 * JS errors, network failures, and DOM state.
 *
 * Usage: node test/browser.mjs [--port 20000] [--timeout 30]
 */

import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '20000';
const timeoutSec = args.includes('--timeout') ? parseInt(args[args.indexOf('--timeout') + 1]) : 30;
const url = `http://127.0.0.1:${port}/`;

// Find chromium
let execPath;
for (const bin of ['chromium-browser', 'chromium', 'google-chrome-stable', 'google-chrome']) {
    try {
        execPath = execSync(`which ${bin} 2>/dev/null`).toString().trim();
        if (execPath) break;
    } catch {}
}
if (!execPath) {
    console.error('ERROR: No chromium/chrome found');
    process.exit(1);
}

const consoleMessages = [];
const jsErrors = [];
const networkErrors = [];
const results = { pass: 0, fail: 0, tests: [] };

function test(name, condition, detail) {
    if (condition) {
        results.pass++;
        results.tests.push({ name, status: 'PASS' });
        console.log(`  [PASS] ${name}`);
    } else {
        results.fail++;
        results.tests.push({ name, status: 'FAIL', detail });
        console.log(`  [FAIL] ${name}${detail ? ': ' + detail : ''}`);
    }
}

console.log(`==> Headless browser test: ${url}`);
console.log(`    Chromium: ${execPath}`);
console.log(`    Timeout: ${timeoutSec}s\n`);

const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });

// Capture console messages
page.on('console', msg => {
    const text = msg.text();
    const type = msg.type();
    consoleMessages.push({ type, text });
    if (type === 'error') {
        console.log(`  [console.error] ${text.slice(0, 200)}`);
    }
});

// Capture JS exceptions
page.on('pageerror', err => {
    jsErrors.push(err.message);
    console.log(`  [JS ERROR] ${err.message.slice(0, 200)}`);
});

// Capture failed network requests
page.on('requestfailed', req => {
    networkErrors.push({ url: req.url(), error: req.failure()?.errorText });
    console.log(`  [NET FAIL] ${req.url().slice(0, 120)} — ${req.failure()?.errorText}`);
});

console.log('==> Loading page...');
try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    test('Page loads (domcontentloaded)', true);
} catch (err) {
    test('Page loads (domcontentloaded)', false, err.message);
    await browser.close();
    process.exit(1);
}

// Wait for workbench to boot
console.log(`==> Waiting ${timeoutSec}s for workbench to initialize...`);
await new Promise(r => setTimeout(r, timeoutSec * 1000));

// Check DOM state
console.log('\n==> DOM checks:');

const title = await page.title();
console.log(`    Page title: "${title}"`);

// Check if workbench container rendered
const hasWorkbench = await page.evaluate(() => {
    return !!(document.querySelector('.monaco-workbench') ||
              document.querySelector('#workbench\\.parts\\.editor') ||
              document.querySelector('[id*="workbench"]'));
});
test('Workbench container rendered', hasWorkbench);

// Check if shim loaded (globalThis.vscode should exist)
const hasVscodeGlobal = await page.evaluate(() => !!globalThis.vscode);
test('globalThis.vscode exists (shim loaded)', hasVscodeGlobal);

// Check if product JSON is set
const hasProductJson = await page.evaluate(() => !!globalThis._VSCODE_PRODUCT_JSON);
test('globalThis._VSCODE_PRODUCT_JSON exists', hasProductJson);

// Check if NLS messages loaded
const hasNls = await page.evaluate(() => Array.isArray(globalThis._VSCODE_NLS_MESSAGES) && globalThis._VSCODE_NLS_MESSAGES.length > 0);
test('NLS messages loaded', hasNls);

// Check body content for error screens
const bodyText = await page.evaluate(() => document.body.innerText?.slice(0, 2000) || '');
const hasErrorScreen = bodyText.includes('Cursor Web — Error') || bodyText.includes('Boot failed');
test('No error screen displayed', !hasErrorScreen, hasErrorScreen ? bodyText.slice(0, 200) : undefined);

// Check for CursorWeb status messages
const shimLogs = consoleMessages.filter(m => m.text.includes('[CursorWeb]'));
console.log(`\n==> Shim log messages (${shimLogs.length}):`);
for (const log of shimLogs) {
    console.log(`    ${log.text.slice(0, 150)}`);
}

// Check specific shim milestones
const shimTexts = shimLogs.map(l => l.text);
test('Shim: vsda loaded or attempted', shimTexts.some(t => t.includes('vsda')));
test('Shim: workbench loaded', shimTexts.some(t => t.includes('Desktop workbench loaded') || t.includes('Loading desktop workbench')));
test('Shim: workbench.main() called', shimTexts.some(t => t.includes('workbench.main()')));

// Summary
console.log(`\n==> JS Errors (${jsErrors.length}):`);
for (const err of jsErrors.slice(0, 10)) {
    console.log(`    ${err.slice(0, 200)}`);
}

console.log(`\n==> Network Errors (${networkErrors.length}):`);
for (const err of networkErrors.slice(0, 10)) {
    console.log(`    ${err.url.slice(0, 120)} — ${err.error}`);
}

console.log(`\n==> Console errors (${consoleMessages.filter(m => m.type === 'error').length}):`);
for (const msg of consoleMessages.filter(m => m.type === 'error').slice(0, 10)) {
    console.log(`    ${msg.text.slice(0, 200)}`);
}

// Take screenshot
try {
    await page.screenshot({ path: 'test/screenshot.png', fullPage: true });
    console.log('\n==> Screenshot saved: test/screenshot.png');
} catch {}

await browser.close();

console.log(`\n==> Results: ${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail > 0 ? 1 : 0);
