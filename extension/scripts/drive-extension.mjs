#!/usr/bin/env node
/**
 * Drives the real extension in a real Chrome.
 *
 * MV3 extensions cannot be loaded headless in the usual sense — the service
 * worker and the offscreen document both need a full browser — so this runs
 * a persistent context with a visible-but-offscreen window. It loads
 * extension/dist, opens a fixture page, and reads what the extension's own
 * modules produce in the page.
 */
import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync } from 'fs';
import { createCanvas } from 'canvas';
import { tmpdir } from 'os';

// extension/scripts/ -> repo root is two up.
const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(extensionRoot, '..');
const dist = resolve(extensionRoot, 'dist');
// The fixture server. This origin is in host_permissions so the demo runs
// without a click; on any other site the extension holds only `activeTab`,
// which Chrome grants on a user gesture and scopes to that one tab.
const FIXTURES = process.env.FIXTURE_URL ?? 'http://127.0.0.1:5173';

const profile = mkdtempSync(resolve(tmpdir(), 'mudra-'));
let context;

function log(tag, msg) { console.log(`  ${tag.padEnd(10)} ${msg}`); }

/**
 * A real PNG standing in for a captured page.
 *
 * A PNG rather than an SVG data URL: createImageBitmap refuses SVG in a
 * worker-like context, which is a decode failure the pipeline correctly
 * reports as "send no image" — right behaviour, wrong thing being tested.
 * The synthetic Aadhaar number is Verhoeff-valid, so the OCR and verifier
 * stages are being asked a real question.
 */
function makeTestPng() {
  const canvas = createCanvas(400, 200);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 400, 200);
  ctx.fillStyle = '#000000';
  ctx.font = '22px sans-serif';
  ctx.fillText('GOVERNMENT OF INDIA', 20, 60);
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText('2345 6789 0124', 20, 120);
  return canvas.toDataURL('image/png');
}

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=-2400,-2400',
    ],
  });

  // The service worker is the extension actually being alive.
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(sw.url()).host;
  log('extension', `loaded, id ${extensionId}`);
  log('worker', sw.url().replace(`chrome-extension://${extensionId}/`, ''));

  // Surface anything the extension logs or throws.
  const problems = [];
  sw.on('console', (m) => { if (m.type() === 'error') problems.push(`worker: ${m.text()}`); });

  const page = await context.newPage();
  page.on('console', (m) => {
    // The favicon 404 arrives here too, as a generic "Failed to load
    // resource". Same noise, same origin.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      problems.push(`page: ${m.text()}`);
    }
  });
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
  // Chrome asks every origin for a favicon; the fixture server has none.
  // Noise, not a finding.
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) {
      problems.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });
  page.on('pageerror', (e) => problems.push(`page: ${e.message}`));

  const target = `${FIXTURES}/dom-aadhaar.html`;
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  log('page', target);

  // The content script is injected programmatically, not declared in the
  // manifest — the worker does this via chrome.scripting.executeScript when
  // a task starts. Do the same, so the seam under test is the real one.
  const injected = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:5173/*' });
    if (!tab?.id) return { error: 'no fixture tab found' };
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/content/index.js'],
      });
      return { ok: true };
    } catch (e) { return { error: String(e) }; }
  });
  log('inject', injected.ok ? 'content script injected' : `✗ ${injected.error}`);
  if (injected.error) problems.push(`inject: ${injected.error}`);

  // Ask it for the viewport info the capture path depends on — that round
  // trip is the content-script/service-worker seam working.
  const viewport = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:5173/*' });
    if (!tab?.id) return { error: 'no fixture tab found' };
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIEWPORT_INFO' });
    } catch (e) {
      return { error: String(e) };
    }
  });
  if (viewport?.error) {
    log('content', `✗ ${viewport.error}`);
    problems.push(`content script: ${viewport.error}`);
  } else {
    log('content', `dpr ${viewport.dpr}, viewport ${viewport.width}x${viewport.height}, ` +
                   `${viewport.imageRegions?.length ?? 0} image regions`);
  }

  // Capture the visible tab: the first half of the visual pass.
  const capture = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:5173/*' });
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { ok: true, bytes: Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  if (capture.ok) {
    log('capture', `${capture.bytes.toLocaleString()} bytes of raw PNG`);
  } else if (/activeTab/.test(capture.error ?? '')) {
    // By design, not a defect. captureVisibleTab needs activeTab, which
    // Chrome grants on a user gesture — clicking the extension — and scopes
    // to that one tab. The alternative is <all_urls>, which would let MUDRA
    // screenshot every tab at any time, and that is a strange permission for
    // a privacy tool to hold. A headless driver has no toolbar to click, so
    // this step is expected to be unavailable here and available in the demo.
    log('capture', 'needs a user gesture (activeTab) — by design, not available headless');
  } else {
    log('capture', `✗ ${capture.error}`);
    problems.push(`capture: ${capture.error}`);
  }

  // The offscreen document: where the pixels are meant to live.
  const offscreen = await sw.evaluate(async () => {
    try {
      const has = await chrome.offscreen.hasDocument();
      if (!has) {
        await chrome.offscreen.createDocument({
          url: 'src/offscreen/offscreen.html',
          reasons: ['DOM_PARSER', 'WORKERS'],
          justification: 'smoke test',
        });
      }
      return { ok: true, created: !has };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  log('offscreen', offscreen.ok ? (offscreen.created ? 'created' : 'already up')
                                : `✗ ${offscreen.error}`);

  // Ask the offscreen document whether vision loaded. With no weights this
  // must report ready:false — the fail-closed path, live.
  if (offscreen.ok) {
    const vision = await sw.evaluate(async () => {
      try {
        return await Promise.race([
          chrome.runtime.sendMessage({ target: 'offscreen', type: 'VISION_STATUS' }),
          new Promise((r) => setTimeout(() => r({ timeout: true }), 25000)),
        ]);
      } catch (e) { return { error: String(e) }; }
    });
    log('vision', JSON.stringify(vision));
  }

  // The offscreen pipeline, exercised on a real image in a real browser.
  //
  // This is the part no unit test can reach: OffscreenCanvas, createImageBitmap,
  // the ONNX runtime, Tesseract's worker and the re-OCR verifier, all running
  // under the extension's real CSP. We hand it a synthetic page image rather
  // than a captured one so the step does not depend on a gesture.
  if (offscreen.ok) {
    const result = await sw.evaluate(async (dataUrl) => {
      try {
        return await Promise.race([
          chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'OBSERVE',
            request: {
              dataUrl,
              dpr: 1,
              imageRegions: [{ x: 0, y: 0, width: 400, height: 200 }],
              domSensitiveBoxes: [
                { bbox: { x: 10, y: 80, width: 260, height: 40 }, inputType: 'password' },
              ],
              knownPiiValues: ['234567890124'],
              canaries: { planted: 3, escaped: 0 },
            },
          }),
          new Promise((r) => setTimeout(() => r({ timeout: true }), 60000)),
        ]);
      } catch (e) { return { error: String(e) }; }
    }, makeTestPng());

    if (result?.error || result?.timeout) {
      log('pipeline', `✗ ${result.error ?? 'timed out'}`);
      problems.push(`offscreen pipeline: ${result.error ?? 'timeout'}`);
    } else {
      const e = result.evidence ?? {};
      log('pipeline', `image sent: ${e.screenshotB64 ? 'yes' : 'no'}` +
                      (e.withheld ? `  (${e.withheld.slice(0, 70)})` : ''));
      log('pipeline', `masks ${e.maskedRegions?.length ?? 0}, faces ${e.faceCount ?? 0}, ` +
                      `ocr regions ${e.ocrRegionCount ?? 0}, verified ${e.reOcrVerified}`);
      log('pipeline', `warmup ${result.warmupMs} ms, stages ${JSON.stringify(result.timings)}`);
      // The invariant, checked live: no verification means no pixels.
      if (!e.reOcrVerified && e.screenshotB64) {
        problems.push('FAIL-CLOSED VIOLATED: an unverified image carried pixels');
      }
    }
  }

  // OCR on its own. The committed tessdata, the Tesseract WASM copied out of
  // node_modules, and the CSP that lets it compile — all of it either works
  // in a real browser or it does not, and nothing short of this proves it.
  if (offscreen.ok) {
    const ocr = await sw.evaluate(async (dataUrl) => {
      try {
        return await Promise.race([
          chrome.runtime.sendMessage({ target: 'offscreen', type: 'OCR_PROBE', dataUrl }),
          new Promise((r) => setTimeout(() => r({ timeout: true }), 90000)),
        ]);
      } catch (e) { return { error: String(e) }; }
    }, makeTestPng());

    if (ocr?.ok) {
      const pii = (ocr.found ?? []).filter((f) => f.isPII);
      log('ocr', `read the image, ${ocr.found.length} result(s)`);
      for (const f of ocr.found.slice(0, 4)) {
        log('ocr', `  ${f.isPII ? 'PII ' : '    '}${f.kind.padEnd(8)} ${JSON.stringify(f.text.slice(0, 60))}`);
      }
      if (pii.some((f) => f.kind === 'aadhaar')) {
        log('ocr', '✓ found the Aadhaar number in the pixels, with no DOM help');
      } else {
        log('ocr', '✗ did not classify the Aadhaar number');
        problems.push('OCR did not find the Aadhaar number in the test image');
      }
    } else {
      log('ocr', `✗ ${ocr?.reason ?? ocr?.error ?? 'timed out'}`);
      problems.push(`ocr: ${ocr?.reason ?? ocr?.error ?? 'timeout'}`);
    }
  }

  // Open the side panel page directly and confirm it renders.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`,
                   { waitUntil: 'domcontentloaded' });
  await panel.waitForTimeout(1500);
  const panelText = (await panel.locator('body').innerText()).trim();
  log('panel', panelText ? `renders: ${panelText.split('\n')[0].slice(0, 60)}`
                         : '✗ rendered blank');
  await panel.screenshot({ path: resolve(extensionRoot, 'scripts/panel.png') });
  log('panel', 'screenshot → extension/scripts/panel.png');

  console.log();
  if (problems.length) {
    console.log('  Problems:');
    for (const p of [...new Set(problems)]) console.log(`    ✗ ${p}`);
    process.exitCode = 1;
  } else {
    console.log('  No errors from the worker, the page or the panel.');
  }
} catch (err) {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
