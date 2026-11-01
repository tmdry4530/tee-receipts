// Headless browser test of the verify page against the REAL NEAR testnet contract (read-only view calls).
// Loads the default bundle (fixtures/testnet), expects VERIFIED, clicks "Tamper one byte", expects NOT VERIFIED,
// clicks "Reset bytes", expects VERIFIED again. Needs network + a Chromium:
//   npx playwright-core install chromium   (or set CHROME_PATH=/usr/bin/google-chrome)
import { chromium } from 'playwright-core';
import { startServer } from './serve-web.mjs';

const server = await startServer(0);
const url = `http://127.0.0.1:${server.address().port}/web/`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const rpcHosts = new Set();
page.on('request', (r) => { if (r.method() === 'POST') rpcHosts.add(new URL(r.url()).host); });

const waitVerdict = async () => {
  await page.waitForFunction(() => ['verified', 'not-verified'].includes(document.body.dataset.verdict), null, { timeout: 60_000 });
  return page.evaluate(() => ({
    verdict: document.body.dataset.verdict,
    banner: document.getElementById('verdict').textContent,
    checks: [...document.querySelectorAll('#checks li')].map((li) => `${li.className === 'ok' ? 'PASS' : 'FAIL'} ${li.children[2].firstChild.textContent}`),
    history: document.querySelectorAll('#hist-body tr').length,
  }));
};
const report = (label, r) => { console.log(`\n[${label}] ${r.banner}  (${r.checks.length} checks, ${r.history} signer-history rows)`); r.checks.forEach((c) => console.log('  ' + c)); };

let failed = false;
const expect = (cond, msg) => { if (!cond) { failed = true; console.error('ASSERTION FAILED: ' + msg); } };
try {
  await page.goto(url);
  const a = await waitVerdict(); report('default bundle', a);
  expect(a.verdict === 'verified' && a.checks.every((c) => c.startsWith('PASS')) && a.checks.length >= 8, 'default bundle should be VERIFIED');
  expect(a.history >= 1, 'signer history should be shown');

  await page.click('#tamper');
  const b = await waitVerdict(); report('after tamper one byte', b);
  console.log('  note: ' + await page.textContent('#tamper-note'));
  expect(b.verdict === 'not-verified', 'tampered bytes should be NOT VERIFIED');
  expect(b.checks.some((c) => c.startsWith('FAIL verify_receipt')), 'verify_receipt should fail after tamper');

  await page.click('#reset');
  const c = await waitVerdict(); report('after reset', c);
  expect(c.verdict === 'verified', 'reset should verify again');
  expect(errors.length === 0, `page errors: ${errors.join('; ')}`);
  expect([...rpcHosts].every((h) => /near\.org|fastnear\.com/.test(h)), `unexpected POST hosts ${[...rpcHosts]}`);
  console.log(`\nRPC hosts contacted (POST): ${[...rpcHosts].join(', ')}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? '\nWEB TEST FAILED' : '\nWEB TEST PASSED');
process.exit(failed ? 1 : 0);
