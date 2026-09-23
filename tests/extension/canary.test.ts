import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateCanaries, registerCanaries, currentCanaries, clearCanaries,
  scanForCanaries, assertNoCanaries, canaryReport, scanPlannerResponse,
  verhoeffCheckDigit, luhnCheckDigit, CanaryEscape,
} from '../../extension/src/shared/canary';
import { plantCanaries, canaryNodePresent } from '../../extension/src/content/canary-node';
import { isAadhaar, isValidLuhn, isPII, piiKind } from '../../extension/src/content/redaction';
import { buildOutbound, redactPageIR } from '../../extension/src/shared/redact';
import { ocrRegions } from '../../extension/src/offscreen/ocr';
import { capturePageIR } from '../../extension/src/content/perception';
import type { PageIR } from '../../extension/src/shared/types';

beforeEach(() => clearCanaries());

describe('check digits', () => {
  it('produces Verhoeff-valid Aadhaar numbers', () => {
    for (let i = 0; i < 50; i++) {
      const body = String(2 + (i % 8)) + String(i).padStart(10, '0').slice(0, 10);
      expect(isAadhaar(body + verhoeffCheckDigit(body))).toBe(true);
    }
  });

  it('produces Luhn-valid card numbers', () => {
    for (let i = 0; i < 50; i++) {
      const body = '4' + String(i).padStart(14, '0');
      expect(isValidLuhn(body + luhnCheckDigit(body))).toBe(true);
    }
  });
});

describe('generateCanaries', () => {
  it('mints three canaries that the real detector recognises as PII', () => {
    // A canary that failed its own checksum would be ignored by the redactor
    // and sail through the payload, reporting a leak that never happened.
    const canaries = generateCanaries();
    expect(canaries).toHaveLength(3);
    for (const c of canaries) expect(isPII(c.value)).toBe(true);
    expect(canaries.map((c) => piiKind(c.value)).sort())
      .toEqual(['AADHAAR', 'CARD', 'PAN']);
  });

  it('mints fresh values each observation', () => {
    const a = generateCanaries().map((c) => c.value);
    const b = generateCanaries().map((c) => c.value);
    expect(a).not.toEqual(b);
  });

  it('replaces the previous observation’s canaries rather than accumulating', () => {
    generateCanaries();
    generateCanaries();
    expect(currentCanaries()).toHaveLength(3);
  });
});

describe('scanForCanaries scans the serialised body', () => {
  it('finds a canary nested anywhere in the JSON', () => {
    const canaries = generateCanaries();
    // The bug this exists to catch: a value riding out inside a field nobody
    // thought to walk.
    const body = JSON.stringify({
      page_ir: { elements: [{ meta: { debug: { was: canaries[0].value } } }] },
    });
    expect(scanForCanaries(body)).toHaveLength(1);
  });

  it('finds a canary that was reformatted with spaces on the way out', () => {
    const canaries = generateCanaries();
    const spaced = canaries[0].value.replace(/(\d{4})(?=\d)/g, '$1 ');
    expect(scanForCanaries(JSON.stringify({ x: spaced }))).toHaveLength(1);
  });

  it('is quiet on a clean body', () => {
    generateCanaries();
    expect(scanForCanaries(JSON.stringify({ elements: [{ ref: 'ref_ab12' }] }))).toEqual([]);
  });

  it('is quiet on an empty body', () => {
    generateCanaries();
    expect(scanForCanaries('')).toEqual([]);
  });
});

describe('assertNoCanaries', () => {
  it('passes a properly redacted payload', () => {
    generateCanaries();
    expect(() => assertNoCanaries(JSON.stringify({ elements: [] }))).not.toThrow();
  });

  it('aborts on a deliberately leaky payload builder', () => {
    // A builder that forgets to redact. This is the whole test.
    const canaries = generateCanaries();
    const leakyBuild = (values: string[]) => JSON.stringify({ snippets: values });
    expect(() => assertNoCanaries(leakyBuild(canaries.map((c) => c.value))))
      .toThrow(CanaryEscape);
  });

  it('names the kinds but never the values it caught', () => {
    const canaries = generateCanaries();
    try {
      assertNoCanaries(JSON.stringify({ leak: canaries[0].value }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CanaryEscape);
      const message = (err as Error).message;
      expect(message).toContain('aadhaar');
      for (const c of canaries) expect(message).not.toContain(c.value);
    }
  });

  it('carries a report of what escaped', () => {
    const canaries = generateCanaries();
    try {
      assertNoCanaries(JSON.stringify({ a: canaries[0].value, b: canaries[2].value }));
    } catch (err) {
      const report = (err as CanaryEscape).report;
      expect(report).toEqual({ planted: 3, escaped: 2, escapedKinds: ['aadhaar', 'card'] });
    }
  });
});

describe('canaryReport', () => {
  it('reads as "3 planted, 0 escaped"', () => {
    generateCanaries();
    expect(canaryReport([])).toEqual({ planted: 3, escaped: 0, escapedKinds: [] });
  });
});

describe('scanPlannerResponse', () => {
  it('catches a canary echoed back by the model', () => {
    const canaries = generateCanaries();
    const reply = JSON.stringify({ action: 'type', text: canaries[1].value });
    expect(scanPlannerResponse(reply)).toHaveLength(1);
  });

  it('is quiet on an ordinary plan', () => {
    generateCanaries();
    expect(scanPlannerResponse('{"action":"click","element_id":"ref_ab12"}')).toEqual([]);
  });
});

describe('canaries travel the real paths, not a parallel one', () => {
  it('enters through the DOM and is sealed by the ordinary redactor', () => {
    document.body.innerHTML = '<h1>Account</h1>';
    const canaries = generateCanaries();
    const unplant = plantCanaries(canaries);
    expect(canaryNodePresent()).toBe(true);

    // capturePageIR walks the real DOM; redactPageIR is the real redactor.
    const ir = capturePageIR();
    unplant();

    const { payload } = buildOutbound(redactPageIR(ir), ir);
    const serialised = JSON.stringify(payload);
    // The outbound body carries no canary — which is the claim being tested.
    expect(scanForCanaries(serialised, canaries)).toEqual([]);
  });

  it('removes the planted node even if capture throws', () => {
    document.body.innerHTML = '';
    const unplant = plantCanaries(generateCanaries());
    try { throw new Error('capture blew up'); } catch { /* as the content script does */ }
    unplant();
    // Fake identifiers must not be left sitting in someone else's DOM.
    expect(canaryNodePresent()).toBe(false);
  });

  it('plants an inert node that does not disturb the page', () => {
    document.body.innerHTML = '<p>content</p>';
    const unplant = plantCanaries(generateCanaries());
    const node = document.getElementById('__mudra_canary__')!;
    expect(node.getAttribute('aria-hidden')).toBe('true');
    expect(node.style.position).toBe('absolute');
    expect(node.style.pointerEvents).toBe('none');
    unplant();
  });

  it('enters the OCR stream and is classified by the same classifier', async () => {
    const canaries = generateCanaries();
    const text = canaries.map((c) => c.value).join('\n');
    const out = await ocrRegions(null, [], { canaryText: text });
    const kinds = out.regions.filter((r) => r.isPII).map((r) => r.kind);
    // If the OCR path failed to flag these, it would fail to flag a real
    // Aadhaar number read off a scanned card too.
    expect(kinds).toEqual(expect.arrayContaining(['aadhaar', 'pan', 'card']));
  });

  it('does not inflate the masked-region count with off-screen canaries', async () => {
    const out = await ocrRegions(null, [], {
      canaryText: generateCanaries().map((c) => c.value).join('\n'),
    });
    // The canary has no pixels on screen; a mask for it would be a no-op
    // that made a number we show the user untrue.
    for (const r of out.regions) {
      if (r.isPII) expect(r.rect.width).toBe(0);
    }
  });
});

describe('canaries never reach storage or the panel counts', () => {
  const ir: PageIR = {
    url: 'https://example.test/',
    title: 'Account',
    elements: [],
    text_snippets: [],
    observed_at: '2026-01-01T00:00:00Z',
  };

  it('reports counts, never values', () => {
    const canaries = generateCanaries();
    const r = redactPageIR(ir, {
      faces: 0, ocrRegions: 0, maskedRegions: 0, reOcrVerified: false,
      canariesPlanted: 3, canariesEscaped: 0,
    });
    expect(r.redaction.canariesPlanted).toBe(3);
    expect(r.redaction.canariesEscaped).toBe(0);
    const serialised = JSON.stringify(r.redaction);
    for (const c of canaries) expect(serialised).not.toContain(c.value);
  });

  it('keeps no canary in the registry once the observation is cleared', () => {
    generateCanaries();
    clearCanaries();
    expect(currentCanaries()).toEqual([]);
    expect(scanForCanaries(JSON.stringify({ anything: 'at all' }))).toEqual([]);
  });

  it('adopts canaries minted in the content script', () => {
    const canaries = generateCanaries();
    clearCanaries();
    registerCanaries(canaries);
    expect(currentCanaries().map((c) => c.value)).toEqual(canaries.map((c) => c.value));
  });
});
