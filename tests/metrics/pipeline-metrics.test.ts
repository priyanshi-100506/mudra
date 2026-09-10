/**
 * Measured metrics for the local pipeline: detection accuracy, throughput,
 * and how much of the page actually leaves the device.
 *
 * The corpus carries hard negatives on purpose — strings shaped like PII that
 * are not PII. Precision measured only against obvious non-matches ("hello")
 * is meaningless; what matters is whether a 12-digit order number, a 16-digit
 * reference, or "meet me @ 5pm" survives.
 *
 * Checksum-valid samples were generated from the published Verhoeff and Luhn
 * tables independently of the implementation under test, so this does not
 * confirm itself.
 *
 * Run: npx vitest run tests/metrics --config extension/vitest.config.ts
 */
import { describe, it, expect } from 'vitest';
import { isPII, redactSnippets } from '../../extension/src/content/redaction';
import { redactPageIR, buildOutbound, isSensitive } from '../../extension/src/shared/redact';
import type { PageIR, PageElement } from '../../extension/src/shared/types';

// ── corpus ────────────────────────────────────────────────────────────────
const POSITIVES: Array<[string, string]> = [
  ['AADHAAR', '234567890124'],
  ['AADHAAR', '499186651282'],
  ['AADHAAR', '789012345674'],
  ['AADHAAR', '4991 8665 1282'],
  ['PAN', 'ABCDE1234F'],
  ['PAN', 'AAAPZ1234C'],
  ['CARD', '4111111111111111'],
  ['CARD', '5500005555555559'],
  ['CARD', '378282246310005'],
  ['IFSC', 'SBIN0001234'],
  ['IFSC', 'HDFC0000123'],
  ['EMAIL', 'alice@example.com'],
  ['EMAIL', 'k.shree+tag@sub.domain.co.in'],
  ['UPI', 'user@okhdfcbank'],
  ['UPI', 'someone@upi'],
  ['PASSPORT', 'A1234567'],
  ['card with spaces', '4111 1111 1111 1111'],
];

/**
 * PII embedded in running text. `isPII` deliberately anchors on the whole
 * value — it answers "is this field's value an identifier". Text inside a
 * heading or label is handled by the snippet redactor instead, so it is
 * measured against that.
 */
const EMBEDDED: Array<[string, string]> = [
  ['PAN in sentence', 'Your PAN ABCDE1234F is on file', ] as [string, string],
  ['email in sentence', 'Write to alice@example.com for help'],
  ['card in sentence', 'Card ending 4111111111111111 was charged'],
  ['aadhaar in sentence', 'Aadhaar 499186651282 verified'],
  ['ifsc in sentence', 'Use IFSC SBIN0001234 for transfers'],
];

/** Shaped like PII, but not. Every one of these must come back false. */
const HARD_NEGATIVES: Array<[string, string]> = [
  ['12-digit order no (fails Verhoeff)', '234567890123'],
  ['12-digit repeated (fails Verhoeff)', '111111111111'],
  ['12-digit near-miss', '499186651281'],
  ['16-digit ref (fails Luhn)', '1234567890123456'],
  ['card near-miss (fails Luhn)', '4111111111111112'],
  ['PAN lowercase', 'abcde1234f'],
  ['PAN wrong shape', 'ABCD12345F'],
  ['IFSC 5th char not 0', 'SBIN1001234'],
  ['passport 0 after letter', 'A0234567'],
  ['plain 8 digits', '12345678'],
  ['time with at-sign', 'Meet me @ 5pm'],
  ['handle', '@username'],
  ['price', 'Rs. 1,24,500'],
  ['date', '2026-09-10'],
  ['ordinary word', 'hello'],
  ['label text', 'Credit Card Number'],
  ['sentence', 'Your account has been updated'],
  ['luhn-valid IMEI', '490154203237518'],
  ['tracking no', 'AB123456789IN'],
  ['invoice ref', 'INV-2026-0004321'],
  ['hex id', 'a1b2c3d4e5f6'],
  ['at in path', 'https://x.test/user@2'],
  ['version string', 'v1.2.3-rc.4'],
];

/**
 * PII the value-level detectors do not attempt. They are pattern-and-checksum
 * matchers for *structured* identifiers; a person's name has no checksum and
 * no shape. Measuring recall without this category would flatter the system,
 * so it is reported separately rather than left out.
 */
const UNSTRUCTURED: Array<[string, string]> = [
  ['full name', 'Kavya Shree Patel'],
  ['street address', '14 Nehru Road, Ahmedabad 380009'],
  ['date of birth value', '17/04/1998'],
  ['indian mobile', '9876543210'],
  ['mobile with code', '+91 98765 43210'],
  ['employer', 'Reserve Bank of India'],
  ['medical note', 'Diagnosed with type 2 diabetes'],
  ['salary figure', 'CTC 18,50,000 per annum'],
];

function rate(n: number, d: number) { return d === 0 ? 1 : n / d; }
function pct(x: number) { return (x * 100).toFixed(1) + '%'; }

// ── detection accuracy ────────────────────────────────────────────────────
describe('detection accuracy (value-level, isPII)', () => {
  const tp = POSITIVES.filter(([, v]) => isPII(v));
  const fn = POSITIVES.filter(([, v]) => !isPII(v));
  const fp = HARD_NEGATIVES.filter(([, v]) => isPII(v));
  const tn = HARD_NEGATIVES.filter(([, v]) => !isPII(v));

  const precision = rate(tp.length, tp.length + fp.length);
  const recall = rate(tp.length, tp.length + fn.length);
  const f1 = rate(2 * precision * recall, precision + recall);

  it('reports the confusion matrix', () => {
    console.log('\n  DETECTION — value level (isPII)');
    console.log(`    corpus            ${POSITIVES.length} positives, ${HARD_NEGATIVES.length} hard negatives`);
    console.log(`    true positives    ${tp.length}`);
    console.log(`    false negatives   ${fn.length}${fn.length ? '  ' + fn.map(([k, v]) => `${k}:${v}`).join(', ') : ''}`);
    console.log(`    false positives   ${fp.length}${fp.length ? '  ' + fp.map(([k, v]) => `${k}:${v}`).join(', ') : ''}`);
    console.log(`    true negatives    ${tn.length}`);
    console.log(`    precision         ${pct(precision)}`);
    console.log(`    recall            ${pct(recall)}`);
    console.log(`    F1                ${pct(f1)}`);
    expect(tp.length + fn.length).toBe(POSITIVES.length);
  });

  it('recall does not regress below 90%', () => expect(recall).toBeGreaterThanOrEqual(0.9));
  it('precision does not regress below 90%', () => expect(precision).toBeGreaterThanOrEqual(0.9));

  it('measures embedded PII via the snippet redactor', () => {
    const out = redactSnippets(EMBEDDED.map(([, v]) => v));
    let caught = 0;
    console.log('\n  EMBEDDED PII — snippet redactor (redactSnippets)');
    for (let i = 0; i < EMBEDDED.length; i++) {
      const [label, original] = EMBEDDED[i];
      const changed = out[i] !== original;
      if (changed) caught++;
      console.log(`      ${changed ? 'redacted' : 'MISSED  '} ${label.padEnd(20)} -> ${out[i]}`);
    }
    console.log(`    recall            ${pct(rate(caught, EMBEDDED.length))}`);
    expect(caught).toBe(EMBEDDED.length);
  });

  it('reports coverage of unstructured PII', () => {
    const caught = UNSTRUCTURED.filter(([, v]) => isPII(v));
    console.log('\n  COVERAGE GAP — PII with no structure to match');
    console.log(`    samples           ${UNSTRUCTURED.length}`);
    console.log(`    detected by value ${caught.length}  (${pct(rate(caught.length, UNSTRUCTURED.length))})`);
    for (const [k, v] of UNSTRUCTURED) {
      console.log(`      ${isPII(v) ? 'caught ' : 'MISSED '} ${k.padEnd(22)} ${v}`);
    }
    console.log('    -> these are reached only when the field LABEL is sensitive,');
    console.log('       not from the value itself. A name in a "Full Name" field is sent.');
  });
});

// ── field-level classification ────────────────────────────────────────────
const el = (p: Partial<PageElement>): PageElement =>
  ({ id: 'e', role: 'textbox', name: '', visible: true, enabled: true, ...p });

describe('classification accuracy (field-level, isSensitive)', () => {
  const sensitive: PageElement[] = [
    el({ name: 'Login Password', input_type: 'password' }),
    el({ name: 'Registered Card Number' }),
    el({ name: 'CVV' }),
    el({ name: 'Aadhaar Number' }),
    el({ name: 'PAN' }),
    el({ name: 'Date of Birth' }),
    el({ name: 'IFSC' }),
    el({ name: 'x', autocomplete: 'cc-number' }),
    el({ name: 'x', autocomplete: 'current-password' }),
    el({ name: 'Account Number' }),
  ];
  const ordinary: PageElement[] = [
    el({ name: 'Home Branch', value: 'Ahmedabad Main' }),
    el({ name: 'Customer ID', value: 'demo-user' }),
    el({ name: 'Search' }),
    el({ name: 'Notes (optional)' }),
    el({ name: 'Role' }),
    el({ name: 'Amount', value: '500' }),
    el({ name: 'Payee', value: 'Acme Ltd' }),
    el({ name: 'Sign In', role: 'button' }),
  ];

  const tp = sensitive.filter(isSensitive).length;
  const fn = sensitive.length - tp;
  const fp = ordinary.filter(isSensitive).length;
  const precision = rate(tp, tp + fp);
  const recall = rate(tp, tp + fn);

  it('reports field-level accuracy', () => {
    console.log('\n  CLASSIFICATION — field level (isSensitive)');
    console.log(`    corpus            ${sensitive.length} sensitive, ${ordinary.length} ordinary`);
    console.log(`    recall            ${pct(recall)}  (${tp}/${sensitive.length} sensitive fields caught)`);
    console.log(`    precision         ${pct(precision)}`);
    console.log(`    over-redaction    ${fp} of ${ordinary.length} ordinary fields`);
    if (fp) console.log(`      -> ${ordinary.filter(isSensitive).map((e) => e.name).join(', ')}`);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});

// ── throughput and egress ─────────────────────────────────────────────────
function page(n: number): PageIR {
  const elements: PageElement[] = [];
  for (let i = 0; i < n; i++) {
    const sensitive = i % 4 === 0;
    elements.push(el({
      id: `e${i}`,
      name: sensitive ? 'Registered Card Number' : `Field ${i}`,
      input_type: sensitive ? 'password' : 'text',
      value: sensitive ? '4111111111111111' : `value ${i}`,
      bbox: { x: i, y: i, width: 120, height: 32 },
    }));
  }
  return {
    url: 'https://bank.example.in/login?token=s3cr3t&page=2',
    title: 'Sign in',
    elements,
    text_snippets: ['Sign in to your account', 'Your PAN on file is ABCDE1234F'],
    observed_at: '2026-09-10T00:00:00.000Z',
  };
}

describe('throughput and egress', () => {
  it('measures the local pipeline', () => {
    console.log('\n  LOCAL PIPELINE — redact + build + assert');
    const sizes = [10, 30, 60];
    for (const n of sizes) {
      const ir = page(n);
      const runs = 200;
      const t0 = performance.now();
      let bytes = 0;
      for (let i = 0; i < runs; i++) {
        const r = redactPageIR(ir);
        bytes = JSON.stringify(buildOutbound(r, ir).payload).length;
      }
      const ms = (performance.now() - t0) / runs;
      const raw = JSON.stringify(ir).length;
      console.log(
        `    ${String(n).padStart(2)} elements   ${ms.toFixed(2)}ms/observation   ` +
        `payload ${String(bytes).padStart(5)}B vs raw ${String(raw).padStart(5)}B   ` +
        `(${((1 - bytes / raw) * 100).toFixed(0)}% smaller)`,
      );
      expect(ms).toBeLessThan(50);
    }
  });

  it('measures what the payload discloses', () => {
    const ir = page(40);
    const r = redactPageIR(ir);
    const { payload } = buildOutbound(r, ir);
    const wire = JSON.stringify(payload);
    const sensitiveCount = r.elements.filter((e) => e.sensitive).length;

    console.log('\n  EGRESS — what actually crosses the boundary');
    console.log(`    elements described    ${r.elements.length}`);
    console.log(`    sealed into refs      ${sensitiveCount}`);
    console.log(`    raw values on wire    ${[...r.refMap.values()].filter((v) => v.value && wire.includes(v.value)).length}`);
    console.log(`    value keys on wire    ${(wire.match(/"value"/g) ?? []).length}`);
    console.log(`    url query stripped    ${!wire.includes('s3cr3t')}`);
    console.log(`    snippet PII stripped  ${!wire.includes('ABCDE1234F')}`);

    expect([...r.refMap.values()].filter((v) => v.value && wire.includes(v.value))).toHaveLength(0);
    expect(wire).not.toContain('s3cr3t');
    expect(wire).not.toContain('ABCDE1234F');
  });
});
