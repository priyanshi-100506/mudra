#!/usr/bin/env node
/**
 * Measures the payload ratio on demo/kyc.html, for real.
 *
 * Both numbers come from actual artefacts: the byte length of a real PNG
 * capture of the page, and the UTF-8 byte length of the exact body
 * buildOutbound produces for it. Nothing here is estimated, and the ratio is
 * printed to one decimal rather than rounded to something memorable.
 */
import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(extensionRoot, '..');
const dist = resolve(extensionRoot, 'dist');
const PAGE = process.env.DEMO_URL ?? 'http://127.0.0.1:5173/demo/kyc.html';

const profile = mkdtempSync(resolve(tmpdir(), 'mudra-measure-'));
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
           '--no-first-run', '--no-default-browser-check', '--window-position=-2400,-2400'],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PAGE, { waitUntil: 'networkidle' });

  // The raw capture, as a real PNG of the real page.
  const png = await page.screenshot({ type: 'png', fullPage: false });

  // The real outbound body.
  //
  // Measured from the service worker, because that is where the redacted
  // observation actually arrives — chrome.runtime is not reachable from the
  // page's own JavaScript context, only from the content script and the
  // worker. Injecting the content script and waiting for PAGE_IR_CAPTURED
  // is the same sequence a real task performs.
  const body = await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: '*://127.0.0.1/*' });
    if (!t?.id) return null;
    await chrome.scripting.executeScript({
      target: { tabId: t.id }, files: ['src/content/index.js'],
    });
    return new Promise((done) => {
      const listener = (msg) => {
        if (msg?.type === 'PAGE_IR_CAPTURED') {
          chrome.runtime.onMessage.removeListener(listener);
          done(JSON.stringify(msg.pageIR));
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.tabs.sendMessage(t.id, { type: 'CAPTURE_PAGE_IR' });
      setTimeout(() => { chrome.runtime.onMessage.removeListener(listener); done(null); }, 8000);
    });
  }).catch(() => null);

  const sentBytes = body ? Buffer.byteLength(body, 'utf8') : null;
  const rawBytes = png.length;

  console.log('\n  Payload measurement — demo/kyc.html');
  console.log('  ' + '─'.repeat(56));
  console.log(`  raw screenshot   ${rawBytes.toLocaleString()} bytes`);
  if (sentBytes) {
    const ratio = rawBytes / sentBytes;
    console.log(`  payload sent     ${sentBytes.toLocaleString()} bytes`);
    console.log(`  ratio            ${ratio.toFixed(1)}x less data`);
    const resultsPath = resolve(root, 'eval/results.json');
    const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
    results.payload = {
      ...results.payload,
      measuredOn: 'demo/kyc.html',
      measuredAt: new Date().toISOString(),
      viewport: '1280x900',
      rawScreenshotBytes: rawBytes,
      sentBytes,
      ratio: Number(ratio.toFixed(1)),
      note: 'Both numbers are real artefacts: a PNG capture of the page, and ' +
            'the UTF-8 length of the body the redactor produced for it.',
    };
    writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
    console.log('  ' + '─'.repeat(56));
    console.log('  merged into eval/results.json\n');
  } else {
    console.log('  payload sent     could not capture — see above\n');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
