#!/usr/bin/env node
/**
 * Pre-flight. Run this before going on stage.
 *
 * Every line is green or red, and nothing is ambiguous — a check that says
 * "probably fine" is a check that will be ignored at 9am with a queue
 * behind you. Where a claim can be tested for real rather than inferred,
 * it is: OLLAMA_ORIGINS is verified by making an actual cross-origin request
 * from a chrome-extension:// origin, not by reading the environment
 * variable, because the variable being set in *your* shell says nothing
 * about the server that is already running.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(extensionRoot, '..');

const BACKEND = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000';
const results = [];

const pass = (name, detail) => results.push({ ok: true, name, detail });
const fail = (name, detail, fix) => results.push({ ok: false, name, detail, fix });
const warn = (name, detail, fix) => results.push({ ok: null, name, detail, fix });

// ── 1. Model weights ──────────────────────────────────────────────────────
const modelDir = join(extensionRoot, 'public/models');
const modelFile = join(modelDir, 'version-RFB-320.onnx');
if (!existsSync(modelFile)) {
  fail('Face detector weights', 'version-RFB-320.onnx is not present',
       'Place it in extension/public/models/ — the visual pass will send no image without it.');
} else {
  const buf = readFileSync(modelFile);
  const sha = createHash('sha256').update(buf).digest('hex');
  const readme = existsSync(join(modelDir, 'README.md'))
    ? readFileSync(join(modelDir, 'README.md'), 'utf8') : '';
  if (readme.includes(sha)) {
    pass('Face detector weights', `${(buf.length / 1024).toFixed(0)} KB, hash matches README`);
  } else if (/not yet recorded/i.test(readme)) {
    fail('Face detector weights', `present, but the hash is unrecorded (${sha.slice(0, 16)}…)`,
         'Run: npm run verify:model, then paste the hash into public/models/README.md');
  } else {
    fail('Face detector weights', `present, but the hash does NOT match the README (${sha.slice(0, 16)}…)`,
         'The file on disk is not the one that was recorded. Re-verify its source.');
  }
}

// ── 2. Language data ──────────────────────────────────────────────────────
const tessdata = join(extensionRoot, 'public/tessdata');
const langs = existsSync(tessdata)
  ? readdirSync(tessdata).filter((f) => f.endsWith('.traineddata')) : [];
const missing = ['eng.traineddata', 'hin.traineddata'].filter((f) => !langs.includes(f));
if (missing.length) {
  fail('OCR language data', `missing: ${missing.join(', ')}`,
       'See extension/public/tessdata/README.md. Without these, every image region is masked whole.');
} else {
  const sizes = langs.map((f) => `${f.split('.')[0]} ${(statSync(join(tessdata, f)).size / 1024 / 1024).toFixed(1)} MB`);
  pass('OCR language data', sizes.join(', '));
}

// ── 3. Built extension ────────────────────────────────────────────────────
const dist = join(extensionRoot, 'dist');
const needed = ['manifest.json', 'src/background/service-worker.js',
                'src/offscreen/offscreen.html', 'wasm/ort-wasm-simd-threaded.wasm',
                'wasm/tesseract/worker.min.js'];
const absent = needed.filter((f) => !existsSync(join(dist, f)));
if (absent.length) {
  fail('Extension build', `dist/ is missing: ${absent.join(', ')}`, 'Run: npm run build');
} else {
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes('wasm-unsafe-eval')) {
    fail('Extension build', "manifest CSP lacks 'wasm-unsafe-eval'",
         'Without it Chrome refuses to compile WASM and neither the detector nor OCR can load.');
  } else {
    pass('Extension build', `dist/ complete, CSP allows WASM, v${manifest.version}`);
  }
}

// ── 4. Demo assets ────────────────────────────────────────────────────────
const demoDir = join(root, 'demo');
if (!existsSync(join(demoDir, 'kyc.html'))) {
  fail('Demo page', 'demo/kyc.html is missing');
} else if (!existsSync(join(demoDir, 'assets/specimen-aadhaar.svg'))) {
  fail('Demo page', 'the specimen card is missing', 'Run: node demo/build-assets.mjs');
} else if (!existsSync(join(demoDir, 'assets/applicant-photo.jpg'))) {
  warn('Demo page', 'present, but there is no applicant photo',
       'The face-detection beat will not fire. See demo/README.md.');
} else {
  pass('Demo page', 'kyc.html, specimen card and applicant photo all present');
}

// ── 5. Backend ────────────────────────────────────────────────────────────
let health = null;
try {
  const res = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(4000) });
  health = await res.json();
  if (health.status === 'ok') {
    pass('Backend', `${BACKEND} answering, planner: ${health.planner}`);
  } else {
    fail('Backend', `${BACKEND} is up but ${health.status}: ${health.detail ?? 'no detail'}`,
         'Fix the planner configuration in backend/.env, or set PLANNER=stub.');
  }
} catch (err) {
  fail('Backend', `${BACKEND} is not answering`,
       'Start it: make demo — or uvicorn app.main:app --port 8000 from backend/');
}

// ── 6. Planner ────────────────────────────────────────────────────────────
if (health?.planner) {
  const planner = health.planner;
  if (planner === 'stub') {
    warn('Planner', 'stub — canned plans, no model',
         'Fine as the fallback. If you meant to show a real planner, set PLANNER in backend/.env.');
  } else if (planner === 'gemini') {
    pass('Planner', 'gemini (hosted — needs a working network on the day)');
  } else if (planner === 'ollama') {
    if (health.model_present) pass('Planner', `ollama, ${health.model} pulled`);
    else fail('Planner', `ollama reachable but ${health.model} is not pulled`,
              `Run: ollama pull ${health.model}`);
  }

  // ── 7. OLLAMA_ORIGINS — tested, not inferred ────────────────────────────
  if (planner === 'ollama') {
    const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
    try {
      // The actual request the extension makes, from the origin it makes it
      // from. Reading the env var proves nothing: the server may have been
      // started in another shell, hours ago, without it.
      const res = await fetch(`${ollamaUrl}/api/tags`, {
        headers: { Origin: 'chrome-extension://mudraprefligh000000000000000000' },
        signal: AbortSignal.timeout(4000),
      });
      if (res.status === 403) {
        fail('Ollama CORS', 'returns 403 to an extension origin',
             "Restart it: OLLAMA_ORIGINS='chrome-extension://*' ollama serve");
      } else if (res.ok) {
        pass('Ollama CORS', 'accepts requests from a chrome-extension:// origin');
      } else {
        fail('Ollama CORS', `unexpected HTTP ${res.status} from an extension origin`);
      }
    } catch (err) {
      fail('Ollama CORS', `could not reach ${ollamaUrl}`,
           "Start it: OLLAMA_ORIGINS='chrome-extension://*' ollama serve");
    }
  }
}

// ── 8. No API key on screen ───────────────────────────────────────────────
// Only tracked files: an ignored .env is meant to hold a key, and flagging
// it every run would train whoever reads this to ignore the red lines.
let leaked = [];
try {
  const tracked = execSync('git ls-files', { cwd: root }).toString().trim().split('\n');
  const KEYISH = /(AIza[0-9A-Za-z_\-]{20,}|AQ\.[A-Za-z0-9_\-]{20,}|sk-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,})/;
  for (const rel of tracked) {
    const full = join(root, rel);
    if (!existsSync(full) || statSync(full).size > 2_000_000) continue;
    if (/\.(png|jpg|jpeg|gif|svg|onnx|traineddata|woff2?|mp4|webm)$/i.test(rel)) continue;
    const text = readFileSync(full, 'utf8');
    if (KEYISH.test(text)) leaked.push(rel);
  }
  if (leaked.length) {
    fail('No API key in tracked files', `found something key-shaped in: ${leaked.join(', ')}`,
         'Remove it and rotate the key before presenting.');
  } else {
    pass('No API key in tracked files', `${tracked.length} files scanned, nothing key-shaped`);
  }
} catch {
  warn('No API key in tracked files', 'not a git repository, skipped');
}

// ── Report ────────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';
console.log('\n  MUDRA pre-flight');
console.log('  ' + '─'.repeat(64));
for (const r of results) {
  const mark = r.ok === true ? `${GREEN}  PASS${OFF}`
             : r.ok === false ? `${RED}  FAIL${OFF}`
             : `${YELLOW}  WARN${OFF}`;
  console.log(`${mark}  ${r.name.padEnd(28)} ${r.detail}`);
  if (r.fix) console.log(`        ${DIM}→ ${r.fix}${OFF}`);
}
console.log('  ' + '─'.repeat(64));

const failed = results.filter((r) => r.ok === false).length;
const warned = results.filter((r) => r.ok === null).length;
if (failed === 0 && warned === 0) {
  console.log(`  ${GREEN}Ready.${OFF} Everything checked is green.\n`);
} else if (failed === 0) {
  console.log(`  ${YELLOW}Ready with ${warned} warning(s).${OFF} Read them before you start.\n`);
} else {
  console.log(`  ${RED}Not ready: ${failed} failure(s).${OFF} Fix the lines above.\n`);
  process.exitCode = 1;
}
