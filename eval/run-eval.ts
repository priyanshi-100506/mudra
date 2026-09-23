/**
 * The evaluation harness.
 *
 * It drives the real modules — `capturePageIR`, `redactPageIR`,
 * `buildOutbound` — over the fixtures in this directory, and writes
 * `results.json`. Nothing about detection is reimplemented here; a harness
 * that scored its own copy of the logic would measure the copy.
 *
 * Detection is defined operationally, by the only question that matters:
 * *did the value stay off the wire?* A value is counted as detected when it
 * was present in the page and is absent from the serialised outbound body. A
 * decoy counts as a false positive when it was redacted — a decoy is ordinary
 * page text, and sealing it means the system cannot tell an order number from
 * an Aadhaar number, which is the failure this whole design is arguing
 * against.
 *
 * Rows the pipeline cannot currently produce are reported as `not-run`, never
 * as zero. A zero says "we looked and found nothing"; not-run says "we did
 * not look". Reporting the first when the second is true is the thing this
 * project exists to criticise in other people's numbers.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { JSDOM } from 'jsdom';

import { capturePageIR } from '../extension/src/content/perception';
import { redactPageIR, buildOutbound } from '../extension/src/shared/redact';
import { generateCanaries, scanForCanaries, clearCanaries } from '../extension/src/shared/canary';
import { utf8ByteLength } from '../extension/src/shared/evidence';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(here, '../extension/public/models/version-RFB-320.onnx');
const HAVE_WEIGHTS = existsSync(MODEL);

interface GroundTruthEntry {
  id: string; group: string; title: string; file: string;
  pii: string[]; decoys: string[]; faces: number;
  imageOnly: boolean; devanagari: boolean;
}

const groundTruth = JSON.parse(
  readFileSync(resolve(here, 'ground-truth.json'), 'utf8'),
) as { fixtures: GroundTruthEntry[]; note: string; generated: string };

/** Machine and browser conditions. A number without these invites the question. */
function environment() {
  const safe = (cmd: string) => {
    try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { return 'unknown'; }
  };
  const totalMemGb = () => {
    try {
      const os = require('os') as typeof import('os');
      return `${Math.round(os.totalmem() / 1024 ** 3)} GB`;
    } catch { return 'unknown'; }
  };
  const os = require('os') as typeof import('os');
  return {
    machine: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    ram: totalMemGb(),
    node: process.version,
    chrome: safe(
      '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --version'),
    // Recorded rather than assumed. WebGPU availability is a property of the
    // browser the extension runs in, not of this Node process, so the harness
    // says what it actually exercised.
    inferenceBackend: HAVE_WEIGHTS ? 'wasm (harness runs headless, no WebGPU)' : 'not-run',
    weightsPresent: HAVE_WEIGHTS,
  };
}

interface PerFixture {
  id: string;
  group: string;
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  trueNegatives: number;
  /** Values the perception layer never captured, so the detector never saw. */
  notObserved: number;
  expectedPii: number;
  expectedDecoys: number;
  leakedAfterRedaction: number;
  canariesEscaped: number;
  sentBytes: number;
  localMs: number;
  visual: 'not-run' | 'run';
  notes?: string;
}

const percentiles = (values: number[]) => {
  if (values.length === 0) return { p50: 0, p95: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { p50: at(50), p95: at(95) };
};

/**
 * Gives the fixture synthetic layout.
 *
 * JSDOM has no layout engine, so every element reports a 0x0 rect and the
 * perception layer's visibility check — correctly — discards the entire page.
 * Without this the harness measures an empty payload and reports it as a
 * perfect score, which is how a harness ends up certifying nothing at all.
 *
 * The geometry is invented but the visibility *rule* is not bypassed: an
 * element hidden by display:none, visibility:hidden or aria-hidden is still
 * dropped, because that logic reads computed style, which JSDOM does model.
 */
function giveLayout(dom: JSDOM): void {
  const { window } = dom;
  let seq = 0;
  window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const style = window.getComputedStyle(this);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0,
               right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
    }
    const y = (seq++ % 40) * 24;
    const width = this.tagName === 'IMG' || this.tagName === 'CANVAS' ? 420 : 260;
    const height = this.tagName === 'IMG' || this.tagName === 'CANVAS' ? 260 : 32;
    return { x: 40, y, width, height, top: y, left: 40,
             right: 40 + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
  };
}

function runFixture(entry: GroundTruthEntry): PerFixture {
  const html = readFileSync(resolve(here, entry.file), 'utf8');
  const dom = new JSDOM(html, { url: `https://fixture.test/${entry.id}` });
  giveLayout(dom);

  // Each fixture gets its own JSDOM, so the globals have to be swapped for
  // that realm — including the DOM constructors.
  //
  // `instanceof HTMLInputElement` is the one that matters and the one that
  // silently fails: an element from this JSDOM is not an instance of the
  // *ambient* HTMLInputElement, so the branch that reads input values never
  // runs, every field comes back valueless, and the harness reports a page
  // with no PII on it as a page where no PII leaked. It scored a clean sweep
  // that way before this was noticed.
  const REALM_GLOBALS = [
    'window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement',
    'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLCanvasElement',
    'HTMLImageElement', 'SVGElement', 'getComputedStyle', 'DOMRect',
  ] as const;
  const prior = new Map<string, unknown>();
  for (const key of REALM_GLOBALS) {
    prior.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] =
      (dom.window as unknown as Record<string, unknown>)[key];
  }

  try {
    clearCanaries();
    const canaries = generateCanaries();

    const t0 = performance.now();
    const ir = capturePageIR();
    const redacted = redactPageIR(ir);
    const { payload } = buildOutbound(redacted, ir);
    const localMs = performance.now() - t0;

    const body = JSON.stringify(payload);
    const raw = JSON.stringify(ir);
    const flat = (s: string) => s.replace(/[\s-]/g, '').toLowerCase();
    const inRaw = (value: string) => flat(raw).includes(flat(value));
    const onWire = (value: string) => flat(body).includes(flat(value));

    /**
     * Was this value actually sealed?
     *
     * Absence from the payload is not the test, and assuming it was cost two
     * wrong versions of this harness. Element values are never sent at all —
     * sensitive or not, the scene graph carries no `value` field — so every
     * value on every page is absent from the body, and scoring on absence
     * gives a perfect result for a detector that does nothing.
     *
     * What actually distinguishes a detected value from an ignored one is
     * whether the redactor sealed it into a reference, or stripped it out of
     * a text snippet. So that is what is measured.
     */
    const sealedValues = new Set(
      [...redacted.refMap.values()].map((r) => flat(r.value)).filter(Boolean),
    );
    const inRawSnippets = flat(JSON.stringify(ir.text_snippets ?? []));
    const inSentSnippets = flat(JSON.stringify(payload.text_snippets ?? []));
    const sealed = (value: string) => {
      const v = flat(value);
      if (sealedValues.has(v)) return true;
      // Removed from prose that carried it: also a seal.
      return inRawSnippets.includes(v) && !inSentSnippets.includes(v);
    };

    // A value the perception layer never captured cannot be scored either
    // way. Counting it as a success would be the worst kind of inflated
    // number: absent from the payload because it was redacted, and absent
    // because it was never seen, look identical from the outside, and only
    // one of them is the system working.
    //
    // This is exactly what the first run of this harness got wrong. Every
    // decoy sitting in a table cell scored as a false positive, because
    // table text is not captured into the IR at all. The detector was never
    // asked. So presence in the raw IR is now the precondition for scoring.
    let truePositives = 0;
    let falseNegatives = 0;
    let notObserved = 0;
    for (const value of entry.pii) {
      if (!inRaw(value)) { notObserved += 1; continue; }
      // A leak is the hard failure; an unsealed value is a miss even when
      // the payload shape happened to keep it off the wire this time.
      if (onWire(value) || !sealed(value)) falseNegatives += 1;
      else truePositives += 1;
    }

    // A decoy counts as a false positive when it was observed and then
    // redacted: it is ordinary page text, and sealing it means we cannot
    // tell an order number from an Aadhaar number — every one of those is a
    // field the agent can no longer read.
    let falsePositives = 0;
    let trueNegatives = 0;
    for (const decoy of entry.decoys) {
      if (!inRaw(decoy)) { notObserved += 1; continue; }
      if (sealed(decoy)) falsePositives += 1;
      else trueNegatives += 1;
    }

    return {
      id: entry.id,
      group: entry.group,
      truePositives,
      falseNegatives,
      falsePositives,
      trueNegatives,
      notObserved,
      expectedPii: entry.pii.length,
      expectedDecoys: entry.decoys.length,
      // Image-only PII cannot be found without the visual pass, so it is not
      // counted as a miss by the text pipeline — it is counted as not-run.
      leakedAfterRedaction: entry.pii.filter((v) => inRaw(v) && onWire(v)).length,
      canariesEscaped: scanForCanaries(body, canaries).length,
      sentBytes: utf8ByteLength(body),
      localMs: Number(localMs.toFixed(2)),
      visual: entry.imageOnly && !HAVE_WEIGHTS ? 'not-run' : 'run',
      notes: entry.imageOnly && !HAVE_WEIGHTS
        ? 'Visual pass not run: version-RFB-320.onnx is not present.'
        : undefined,
    };
  } finally {
    for (const [key, value] of prior) {
      (globalThis as Record<string, unknown>)[key] = value;
    }
    dom.window.close();
  }
}

function main() {
  const perFixture = groundTruth.fixtures.map(runFixture);

  const textFixtures = perFixture.filter((f) => f.visual === 'run');
  const tp = textFixtures.reduce((n, f) => n + f.truePositives, 0);
  const fn = textFixtures.reduce((n, f) => n + f.falseNegatives, 0);
  const fp = perFixture.reduce((n, f) => n + f.falsePositives, 0);
  const tn = perFixture.reduce((n, f) => n + f.trueNegatives, 0);
  const notObserved = perFixture.reduce((n, f) => n + f.notObserved, 0);
  // The denominator is decoys the detector was actually shown, not decoys
  // that exist in the fixtures. Scoring the ones it never saw would flatter
  // the rate in exactly the direction we would want it flattered.
  const decoyTotal = fp + tn;

  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const f1 = recall !== null && precision !== null && recall + precision > 0
    ? (2 * recall * precision) / (recall + precision)
    : null;

  const latency = percentiles(perFixture.map((f) => f.localMs));
  const heapMb = Number((process.memoryUsage().heapUsed / 1024 ** 2).toFixed(1));

  const notRun = perFixture.filter((f) => f.visual === 'not-run');

  const results = {
    generated: new Date().toISOString(),
    groundTruthGenerated: groundTruth.generated,
    environment: environment(),

    /**
     * The decoy column, reported at the top rather than as a footnote.
     *
     * This is where checksum validation separates from pattern matching: a
     * 12-digit order number, a 16-digit ticket number and a PAN-shaped SKU
     * all match the regex and all fail their checksum. A regex-only detector
     * seals them, and every one of those is a field the agent can then no
     * longer read.
     */
    decoys: {
      shownToDetector: decoyTotal,
      inFixtures: perFixture.reduce((n, f) => n + f.expectedDecoys, 0),
      correctlyIgnored: tn,
      falsePositives: fp,
      falsePositiveRate: decoyTotal > 0 ? Number((fp / decoyTotal).toFixed(4)) : null,
      kinds: [
        '12-digit order and invoice numbers that fail Verhoeff',
        '16-digit ticket and batch numbers that fail Luhn',
        'PAN-shaped warehouse SKU codes',
        'a stone statue, for the face detector',
      ],
    },

    detection: {
      truePositives: tp,
      falseNegatives: fn,
      falsePositives: fp,
      recall: recall === null ? null : Number(recall.toFixed(4)),
      precision: precision === null ? null : Number(precision.toFixed(4)),
      f1: f1 === null ? null : Number(f1.toFixed(4)),
      notObserved,
      notObservedNote:
        'Values present in a fixture but never captured into the PageIR. ' +
        'Not scored either way: the detector was never asked.',
      scope: notRun.length > 0
        ? `Text pipeline only. ${notRun.length} image-only fixtures not run.`
        : 'Full pipeline, text and visual.',
    },

    leaks: {
      afterRedaction: perFixture.reduce((n, f) => n + f.leakedAfterRedaction, 0),
      canariesPlantedPerObservation: 3,
      canariesEscaped: perFixture.reduce((n, f) => n + f.canariesEscaped, 0),
    },

    latency: {
      // First-load and steady-state are kept apart, the same way the panel
      // keeps warmupMs apart from the stage times. Both are honest; averaging
      // them together is not, because they answer different questions.
      firstLoadMs: HAVE_WEIGHTS ? 'measured-in-browser-only' : 'not-run',
      steadyStateTextPipelineMs: latency,
      visualPassMs: HAVE_WEIGHTS ? 'not-run-in-harness' : 'not-run',
      note:
        'Text-pipeline timings are measured in this harness. Visual-pass and ' +
        'first-load timings are browser-only and are reported by the panel ' +
        'waterfall, not here.',
    },

    payload: {
      // Measured. A raw screenshot figure is only quoted once a real capture
      // has been taken, which needs the browser.
      sentBytesPerObservation: percentiles(perFixture.map((f) => f.sentBytes)),
      rawScreenshotBytes: 'not-run',
      ratio: 'not-run',
      note:
        'The payload-vs-screenshot ratio requires a real capture and is ' +
        'reported by the panel. It is not estimated here.',
    },

    peakHeapMb: heapMb,

    notRun: notRun.map((f) => ({ id: f.id, reason: f.notes })),

    perFixture,
  };

  writeFileSync(resolve(here, 'results.json'), JSON.stringify(results, null, 2) + '\n');

  // A short human summary, so the run says something without opening a file.
  const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  console.log('\nMUDRA evaluation');
  console.log('─'.repeat(58));
  console.log(`  fixtures            ${perFixture.length}  (${notRun.length} not run)`);
  console.log(`  recall              ${pct(recall)}   (text pipeline)`);
  console.log(`  precision           ${pct(precision)}`);
  console.log(`  F1                  ${pct(f1)}`);
  console.log(`  decoy false pos.    ${fp}/${decoyTotal}  ${pct(decoyTotal ? fp / decoyTotal : null)}`);
  console.log(`  leaks after redact  ${results.leaks.afterRedaction}`);
  console.log(`  canaries escaped    ${results.leaks.canariesEscaped}`);
  console.log(`  local p50 / p95     ${latency.p50} / ${latency.p95} ms`);
  console.log(`  peak heap           ${heapMb} MB`);
  if (notRun.length > 0) {
    console.log(`\n  not run: ${notRun.map((f) => f.id).join(', ')}`);
    console.log('  reason:  version-RFB-320.onnx is not present.');
  }
  console.log('─'.repeat(58));
  console.log('  wrote eval/results.json\n');
}

main();
