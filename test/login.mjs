#!/usr/bin/env node
// Login UI persistence test — verifies the login screen stays visible
// Usage: node test/login.mjs [--port PORT] [--timeout SECONDS]
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const getArg = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i+1] ? args[i+1] : def;
};
const PORT = getArg('port', '20000');
const TIMEOUT = parseInt(getArg('timeout', '20'));
const BASE = `http://127.0.0.1:${PORT}/`;

let passed = 0, failed = 0;
const pass = (msg) => { console.log(`  [PASS] ${msg}`); passed++; };
const fail = (msg) => { console.log(`  [FAIL] ${msg}`); failed++; };

const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium-browser',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1080'],
    defaultViewport: { width: 1920, height: 1080 }
});

const page = await browser.newPage();

console.log(`\n==> Login persistence test: ${BASE}`);
console.log(`    Timeout: ${TIMEOUT}s\n`);

// Clear localStorage for a fresh start
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });

// Wait for login UI to appear
let loginAppeared = false;
for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const hasLogin = await page.evaluate(() => {
        const c = document.querySelector('.onboarding-v2-container');
        return c && c.getBoundingClientRect().width > 0;
    });
    if (hasLogin) { loginAppeared = true; break; }
}

loginAppeared ? pass('Login UI appears') : fail('Login UI never appeared');

if (loginAppeared) {
    // Check login UI content
    const content = await page.evaluate(() => {
        const c = document.querySelector('.onboarding-v2-container');
        return c?.textContent || '';
    });
    content.includes('Sign Up') ? pass('Has "Sign Up" button') : fail('Missing "Sign Up" button');
    content.includes('Log In') ? pass('Has "Log In" button') : fail('Missing "Log In" button');

    await page.screenshot({ path: 'test/login-visible.png' });

    // Now wait and verify it STAYS visible
    const checkInterval = 2;
    const checks = Math.floor(TIMEOUT / checkInterval);
    let lastVisible = true;
    let disappearedAt = null;

    for (let i = 0; i < checks; i++) {
        await new Promise(r => setTimeout(r, checkInterval * 1000));
        const elapsed = (i + 1) * checkInterval;

        const state = await page.evaluate(() => {
            const c = document.querySelector('.onboarding-v2-container');
            if (!c) return { exists: false };
            const r = c.getBoundingClientRect();
            const s = getComputedStyle(c);
            return {
                exists: true,
                visible: r.width > 0 && r.height > 0 && s.display !== 'none' &&
                         s.visibility !== 'hidden' && s.opacity !== '0',
                text: c.textContent?.substring(0, 60)
            };
        });

        if (!state.exists || !state.visible) {
            if (lastVisible) {
                disappearedAt = elapsed;
                await page.screenshot({ path: 'test/login-disappeared.png' });
            }
            lastVisible = false;
        }
    }

    if (disappearedAt) {
        fail(`Login UI disappeared after ${disappearedAt}s`);
    } else {
        pass(`Login UI stays visible for ${TIMEOUT}s`);
    }
} else {
    await page.screenshot({ path: 'test/login-missing.png' });
}

console.log(`\n==> Results: ${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
