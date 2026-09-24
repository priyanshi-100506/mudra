#!/usr/bin/env node
/**
 * The visual half of the evaluation, measured in a real browser.
 *
 * It has to be a browser. ONNX Runtime's WASM backend, OffscreenCanvas and
 * Tesseract's worker all need one, and a JSDOM harness that claimed to run
 * them would be measuring itself. So this loads the built extension into
 * Chrome, renders each image fixture, screenshots it, and feeds those real
 * pixels through the same offscreen pipeline the product uses.
 *
 * The screenshot comes from Playwright rather than chrome.tabs.captureVisibleTab
 * because the latter needs an activeTab gesture there is no way to make
 * headlessly. Everything downstream of the pixels — detection, OCR, masking,
 * re-OCR verification — is the real path.
 *
 * Results are merged into eval/results.json.
 */
import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(extensionRoot, '..');
const dist = resolve(extensionRoot, 'dist');
const FIXTURES = process.env.FIXTURE_URL ?? 'http://127.0.0.1:5173/eval/fixtures';

const groundTruth = JSON.parse(
  readFileSync(resolve(root, 'eval/ground-truth.json'), 'utf8'));
const targets = groundTruth.fixtures.filter((f) => f.imageOnly);

const profile = mkdtempSync(resolve(tmpdir(), 'mudra-eval-'));
let context;
const rows = [];

const log = (t, m) => console.log(`  ${t.padEnd(10)} ${m}`);

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
           '--no-first-run', '--no-default-browser-check', '--window-position=-2400,-2400'],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });

  await sw.evaluate(async () => {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['DOM_PARSER', 'WORKERS'],
        justification: 'evaluation',
      });
    }
  });

  const vision = await sw.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'VISION_STATUS' }));
  log('vision', JSON.stringify(vision));
  if (!vision?.ready) throw new Error(`detector not ready: ${vision?.reason}`);

  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 760 });

  // A fixture whose image is missing cannot be measured. Saying "0 faces
  // found" for a page with no face on it would look like a result and be
  // nothing of the kind.
  const photoPresent = existsSync(resolve(root, 'demo/assets/applicant-photo.jpg'));

  for (const fixture of targets) {
    if (fixture.needsPhoto && !photoPresent) {
      rows.push({
        id: fixture.id, group: fixture.group, notMeasurable: true,
        reason: 'demo/assets/applicant-photo.jpg is not present, so the page ' +
                'contains no face. Face recall is untested, not zero.',
      });
      log(fixture.id, 'not measurable — no applicant photo; face recall untested');
      continue;
    }
    const url = `${FIXTURES}/${fixture.id}.html`;
    await page.goto(url, { waitUntil: 'networkidle' });
    const png = await page.screenshot({ type: 'png' });
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

    const started = Date.now();
    const result = await sw.evaluate(async ({ dataUrl, known }) => {
      try {
        return await Promise.race([
          chrome.runtime.sendMessage({
            target: 'offscreen', type: 'OBSERVE',
            request: {
              dataUrl, dpr: 1,
              // The whole page is the region: these fixtures are an image on
              // a mostly blank page, and narrowing by DOM here would import
              // the very DOM knowledge the image-only case is meant to lack.
              imageRegions: [{ x: 0, y: 0, width: 1000, height: 760 }],
              domSensitiveBoxes: [],
              knownPiiValues: known,
              canaries: { planted: 3, escaped: 0 },
            },
          }),
          new Promise((r) => setTimeout(() => r({ timeout: true }), 120000)),
        ]);
      } catch (e) { return { error: String(e) }; }
    }, { dataUrl, known: fixture.pii });

    const ms = Date.now() - started;

    if (result?.error || result?.timeout) {
      rows.push({ id: fixture.id, group: fixture.group, error: result.error ?? 'timeout', ms });
      log(fixture.id, `✗ ${result.error ?? 'timed out'}`);
      continue;
    }

    const e = result.evidence ?? {};
    const labels = (e.maskedRegions ?? []).map((m) => m.label);
    // Did the pipeline find what the ground truth says is in the pixels?
    const wantedKinds = fixture.pii.length > 0;
    const foundPii = labels.some((l) => ['AADHAAR', 'PAN', 'CARD', 'HINDI-OCR'].includes(l));
    const foundFace = labels.includes('FACE');

    rows.push({
      id: fixture.id,
      group: fixture.group,
      expectedPii: fixture.pii.length,
      expectedFaces: fixture.faces ?? 0,
      facesDetected: e.faceCount ?? 0,
      ocrRegions: e.ocrRegionCount ?? 0,
      maskedRegions: (e.maskedRegions ?? []).length,
      labels: [...new Set(labels)],
      piiFound: foundPii,
      faceFound: foundFace,
      reOcrVerified: Boolean(e.reOcrVerified),
      imageSent: Boolean(e.screenshotB64),
      withheld: e.withheld ?? null,
      rawScreenshotBytes: result.rawScreenshotBytes ?? png.length,
      timings: result.timings,
      warmupMs: result.warmupMs,
      wallMs: ms,
    });

    const verdict = wantedKinds ? (foundPii ? 'found PII' : 'MISSED PII')
                  : (fixture.faces ? (foundFace ? 'found face' : 'MISSED face')
                                   : (foundFace ? 'FALSE face' : 'correctly no face'));
    log(fixture.id, `${verdict}  faces=${e.faceCount ?? 0} ocr=${e.ocrRegionCount ?? 0} ` +
                    `masks=${(e.maskedRegions ?? []).length} verified=${e.reOcrVerified} ${ms}ms`);
  }

  // Merge into results.json rather than replacing it: the text harness owns
  // the rest of the file.
  const resultsPath = resolve(root, 'eval/results.json');
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  results.visual = {
    measuredAt: new Date().toISOString(),
    howMeasured:
      'Real Chrome, built extension, page rendered and screenshotted by ' +
      'Playwright, pixels fed through the product offscreen pipeline ' +
      '(UltraFace-320 + Tesseract eng+hin + re-OCR verification).',
    provider: vision.provider,
    warmupMs: vision.warmupMs ?? null,
    fixtures: rows,
  };
  writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
  console.log('\n  merged into eval/results.json\n');
} catch (err) {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
