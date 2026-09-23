import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyRedactedText } from '../../extension/src/offscreen/verify';
import { assembleMasks, withhold, analyseCapture, type AnalyseInput } from '../../extension/src/offscreen/pipeline';
import { redactCanvas } from '../../extension/src/content/redaction';
import { buildOutbound, redactPageIR } from '../../extension/src/shared/redact';
import type { OcrOutcome } from '../../extension/src/offscreen/ocr';
import type { PageIR } from '../../extension/src/shared/types';

const AADHAAR = '234567890124';   // Verhoeff-valid
const DECOY   = '234567890123';   // 12 digits, fails Verhoeff
const CARD    = '4111111111111111';

describe('verifyRedactedText', () => {
  it('passes when nothing sensitive is readable', () => {
    const r = verifyRedactedText(['Government of India', 'Welcome back'], [AADHAAR]);
    expect(r).toEqual({ verified: true, leakedKinds: [] });
  });

  it('fails when a value the observation saw is still readable', () => {
    const r = verifyRedactedText([`UID ${AADHAAR}`], [AADHAAR]);
    expect(r.verified).toBe(false);
    expect(r.leakedKinds).toContain('AADHAAR');
  });

  it('sees through OCR spacing and case differences', () => {
    // The mask failed, and Tesseract read the number back grouped.
    const r = verifyRedactedText(['2345 6789 0124'], [AADHAAR]);
    expect(r.verified).toBe(false);
  });

  it('fails on newly readable PII that was never in the known list', () => {
    // The face mask shifted a card number into view; nobody recorded it in
    // the first pass, so only the pattern check can catch it.
    const r = verifyRedactedText([`card ${CARD}`], []);
    expect(r.verified).toBe(false);
    expect(r.leakedKinds).toContain('CARD');
  });

  it('never puts the leaking value into the reason string', () => {
    const r = verifyRedactedText([`UID ${AADHAAR}`, `card ${CARD}`], [AADHAAR]);
    expect(r.reason).toBeTruthy();
    // A verifier that logged what it caught would have leaked it itself.
    expect(r.reason).not.toContain(AADHAAR);
    expect(r.reason).not.toContain(CARD);
    expect(JSON.stringify(r)).not.toContain(AADHAAR);
  });

  it('does not fail on a decoy that merely looks like an Aadhaar number', () => {
    const r = verifyRedactedText([`Order ${DECOY} dispatched`], []);
    expect(r.verified).toBe(true);
  });

  it('ignores known values too short to be identifying on their own', () => {
    // A 4-digit value would collide with page numbers and years.
    expect(verifyRedactedText(['Page 1234 of 9'], ['1234']).verified).toBe(true);
  });
});

describe('assembleMasks', () => {
  const emptyOcr: OcrOutcome = { regions: [], ocrTruncated: false, unreadRegions: [] };

  it('unions faces, OCR PII, unread regions and DOM boxes', () => {
    const ocr: OcrOutcome = {
      ocrTruncated: true,
      regions: [
        { rect: { x: 10, y: 10, width: 50, height: 50 }, text: AADHAAR, isPII: true, kind: 'aadhaar' },
        { rect: { x: 70, y: 10, width: 50, height: 50 }, text: 'caption', isPII: false, kind: 'other' },
      ],
      unreadRegions: [{ x: 200, y: 200, width: 80, height: 80 }],
    };
    const masks = assembleMasks(
      [{ x: 0, y: 0, width: 40, height: 40, score: 0.9 }],
      ocr,
      [{ bbox: { x: 5, y: 5, width: 20, height: 10 }, inputType: 'password' }],
      2,
    );
    expect(masks.map((m) => m.kind).sort()).toEqual(
      ['DOM_SENSITIVE', 'FACE', 'OCR_PII', 'UNREAD_REGION'],
    );
    // Only the clean OCR region is left unmasked.
    expect(masks.some((m) => m.x === 70)).toBe(false);
  });

  it('converts DOM boxes through the dpr, so masks land on the right pixels', () => {
    const masks = assembleMasks([], emptyOcr,
      [{ bbox: { x: 100, y: 50, width: 200, height: 20 }, inputType: 'password' }], 2);
    expect(masks[0]).toMatchObject({ x: 200, y: 100, width: 400, height: 40, kind: 'DOM_SENSITIVE' });
  });

  it('leaves face boxes in image space untouched', () => {
    const masks = assembleMasks([{ x: 12, y: 8, width: 30, height: 30, score: 1 }], emptyOcr, [], 2);
    expect(masks[0]).toMatchObject({ x: 12, y: 8, kind: 'FACE' });
  });
});

describe('redactCanvas actually covers the pixels', () => {
  function canvasWith(fill: string, w = 200, h = 200): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, w, h);
    return c;
  }

  const pixelAt = (c: HTMLCanvasElement, x: number, y: number) =>
    Array.from(c.getContext('2d')!.getImageData(x, y, 1, 1).data);

  it('paints a face box and an Aadhaar box to black', () => {
    const src = canvasWith('#ffffff');
    const out = redactCanvas(src, [
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 120, y: 120, width: 50, height: 30 },
    ]);
    expect(pixelAt(out, 30, 30).slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(out, 140, 130).slice(0, 3)).toEqual([0, 0, 0]);
    // Unmasked page content survives — this is not a blanked image.
    expect(pixelAt(out, 190, 10).slice(0, 3)).toEqual([255, 255, 255]);
  });

  it('accepts image rects without needing a DOMRect built for it', () => {
    const out = redactCanvas(canvasWith('#ffffff'), [{ x: 0, y: 0, width: 10, height: 10 }]);
    expect(pixelAt(out, 5, 5).slice(0, 3)).toEqual([0, 0, 0]);
  });

  it('does not mutate the source canvas', () => {
    const src = canvasWith('#ffffff');
    redactCanvas(src, [{ x: 0, y: 0, width: 100, height: 100 }]);
    expect(pixelAt(src, 50, 50).slice(0, 3)).toEqual([255, 255, 255]);
  });
});

describe('analyseCapture end to end', () => {
  /** A pipeline whose detector is forced ready, so the later stages are reachable. */
  function inputWith(over: Partial<AnalyseInput> = {}): AnalyseInput {
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 300;
    return {
      bitmap: { width: 400, height: 300 } as ImageBitmap,
      dpr: 1,
      imageRegions: [],
      domSensitiveBoxes: [],
      knownPiiValues: [],
      ocrEngine: null,
      reOcr: async () => [],
      makeCanvas: () => canvas,
      encode: async () => 'REDACTED_PNG_B64',
      ...over,
    };
  }

  it('sends no image when the detector never loaded', async () => {
    // The model is not committed, so initVision genuinely fails here — this
    // is the real fail-closed path, not a mocked one.
    const e = await analyseCapture(inputWith());
    expect(e.screenshotB64).toBeNull();
    expect(e.reOcrVerified).toBe(false);
    expect(e.withheld).toMatch(/face detector unavailable/);
  });
});

describe('the withheld result cannot be talked into carrying pixels', () => {
  it('forces screenshotB64 to null and reOcrVerified to false', () => {
    const e = withhold('verification failed', {
      screenshotB64: 'RAW_PIXELS',
      reOcrVerified: true,
      faces: [{ x: 0, y: 0, width: 1, height: 1, score: 1 }],
    } as never);
    expect(e.screenshotB64).toBeNull();
    expect(e.reOcrVerified).toBe(false);
    // Detection counts still survive: we withhold the image, not the finding.
    expect(e.faces).toHaveLength(1);
  });
});

describe('buildOutbound gates the screenshot on verification', () => {
  const ir: PageIR = {
    url: 'https://example.test/account',
    title: 'Account',
    elements: [],
    text_snippets: [],
    observed_at: '2026-01-01T00:00:00Z',
  };

  it('omits the image entirely when verification failed', () => {
    const r = redactPageIR(ir);
    const { payload } = buildOutbound(r, ir, {
      screenshotB64: 'REDACTED_PNG_B64',
      reOcrVerified: false,
    });
    expect(payload.screenshot_b64).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('REDACTED_PNG_B64');
  });

  it('omits the image when verification passed but there is no image', () => {
    const r = redactPageIR(ir);
    const { payload } = buildOutbound(r, ir, { screenshotB64: null, reOcrVerified: true });
    expect(payload.screenshot_b64).toBeUndefined();
  });

  it('sends the image only when both conditions hold', () => {
    const r = redactPageIR(ir);
    const { payload } = buildOutbound(r, ir, {
      screenshotB64: 'REDACTED_PNG_B64',
      reOcrVerified: true,
    });
    expect(payload.screenshot_b64).toBe('REDACTED_PNG_B64');
  });

  it('omits the image when no vision pass ran at all', () => {
    const r = redactPageIR(ir);
    expect(buildOutbound(r, ir).payload.screenshot_b64).toBeUndefined();
  });
});

describe('real counts replace the hardcoded zeros', () => {
  const ir: PageIR = {
    url: 'https://bank.test/login',
    title: 'Login',
    elements: [
      { id: 'e1', role: 'textbox', name: 'Password', input_type: 'password', value: 'hunter2', visible: true, enabled: true },
    ],
    text_snippets: [],
    observed_at: '2026-01-01T00:00:00Z',
  };

  it('reports what the vision pass actually found', () => {
    const r = redactPageIR(ir, { faces: 2, ocrRegions: 3, maskedRegions: 6, reOcrVerified: true });
    expect(r.detection).toMatchObject({ structuredPii: 1, faces: 2, ocrRegions: 3 });
    expect(r.redaction).toMatchObject({ maskedRegions: 6, reOcrVerified: true, textReferences: 1 });
  });

  it('stays at zero and unverified when no capture was taken', () => {
    const r = redactPageIR(ir);
    expect(r.detection).toMatchObject({ faces: 0, ocrRegions: 0 });
    expect(r.redaction.reOcrVerified).toBe(false);
  });

  it('keeps namedEntities at an honest zero rather than a plausible number', () => {
    expect(redactPageIR(ir, { faces: 9, ocrRegions: 9, maskedRegions: 9, reOcrVerified: true })
      .detection.namedEntities).toBe(0);
  });
});
