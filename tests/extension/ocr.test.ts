import { describe, it, expect } from 'vitest';
import {
  ocrRegions, classifyOcrText, candidateTokens, rectsToMask,
  MAX_OCR_REGIONS, OCR_BUDGET_MS, OCR_LANGS,
  type OcrEngine,
} from '../../extension/src/offscreen/ocr';
import { collectImageRegions, MIN_REGION_PX } from '../../extension/src/content/image-regions';
import type { ImageRect } from '../../extension/src/shared/geometry';
import { isAadhaar, isValidLuhn } from '../../extension/src/content/redaction';

const rect = (i: number): ImageRect => ({ x: i * 10, y: 0, width: 100, height: 100 });

/** An engine whose regions each yield a fixed block of "scanned" text. */
function engineOf(texts: string[]): OcrEngine {
  let i = 0;
  return { async recognise() { return texts[i++] ?? ''; } };
}

describe('classifyOcrText', () => {
  it('flags a Verhoeff-valid Aadhaar number read out of an image', () => {
    // 2234 5678 9012 -- constructed to pass Verhoeff; assert that first.
    const aadhaar = '234567890124';
    expect(isAadhaar(aadhaar)).toBe(true);
    expect(classifyOcrText(aadhaar)).toEqual({ isPII: true, kind: 'aadhaar' });
  });

  it('does NOT flag a 12-digit order number that fails the Verhoeff check', () => {
    // This is the case a regex-only reader gets wrong, and it is the whole
    // argument for reusing the validated DOM detector rather than writing a
    // looser one for pixels.
    const orderNo = '234567890123';
    expect(isAadhaar(orderNo)).toBe(false);
    expect(classifyOcrText(orderNo)).toEqual({ isPII: false, kind: 'other' });
  });

  it('does NOT flag a 16-digit ticket number that fails Luhn', () => {
    const ticket = '4111111111111112';
    expect(isValidLuhn(ticket)).toBe(false);
    expect(classifyOcrText(ticket).isPII).toBe(false);
  });

  it('flags a Luhn-valid card number', () => {
    expect(isValidLuhn('4111111111111111')).toBe(true);
    expect(classifyOcrText('4111111111111111')).toEqual({ isPII: true, kind: 'card' });
  });

  it('flags a PAN and an Indian mobile number', () => {
    expect(classifyOcrText('ABCDE1234F')).toEqual({ isPII: true, kind: 'pan' });
    expect(classifyOcrText('+91 98765 43210')).toEqual({ isPII: true, kind: 'phone' });
  });

  it('leaves ordinary caption text alone', () => {
    expect(classifyOcrText('Government of India').isPII).toBe(false);
    expect(classifyOcrText('Quarterly revenue, 2024').isPII).toBe(false);
  });
});

describe('candidateTokens', () => {
  it('recovers a space-grouped Aadhaar number from a scanned line', () => {
    const tokens = candidateTokens('भारत सरकार\n2345 6789 0124\nDOB 01/01/1990');
    expect(tokens).toContain('2345 6789 0124');
  });

  it('keeps the Devanagari line intact as its own token', () => {
    const hindi = 'आधार';
    expect(candidateTokens(`${hindi}\n1234`)).toContain(hindi);
  });
});

describe('ocrRegions budget', () => {
  const eightTexts = Array.from({ length: 12 }, () => 'ordinary caption text');

  it('reads up to the region cap', async () => {
    const regions = Array.from({ length: 5 }, (_, i) => rect(i));
    const out = await ocrRegions(engineOf(eightTexts), regions);
    expect(out.ocrTruncated).toBe(false);
    expect(out.unreadRegions).toHaveLength(0);
  });

  it('masks every region beyond the cap rather than skipping it', async () => {
    const regions = Array.from({ length: 12 }, (_, i) => rect(i));
    const out = await ocrRegions(engineOf(eightTexts), regions);
    expect(out.ocrTruncated).toBe(true);
    expect(out.unreadRegions).toHaveLength(12 - MAX_OCR_REGIONS);
    // The unread ones are exactly the tail, and all of them get masked.
    expect(rectsToMask(out)).toEqual(expect.arrayContaining(out.unreadRegions));
  });

  it('turns a blown time budget into masks, not into a leak', async () => {
    // A clock that jumps past the budget after the second region.
    let t = 0;
    const now = () => { t += 900; return t; };
    const regions = Array.from({ length: 5 }, (_, i) => rect(i));
    const out = await ocrRegions(engineOf(eightTexts), regions, { now });
    expect(out.ocrTruncated).toBe(true);
    expect(out.unreadRegions.length).toBeGreaterThan(0);
    // Critically: nothing was silently dropped. Every region is accounted
    // for, either as something we read or as something we will black out.
    const accounted = new Set([
      ...out.regions.map((r) => r.rect),
      ...out.unreadRegions,
    ]);
    expect(accounted.size).toBe(regions.length);
    expect(OCR_BUDGET_MS).toBe(1500);
  });

  it('masks a region whose recognition threw', async () => {
    const flaky: OcrEngine = {
      async recognise(r) {
        if (r.x === 10) throw new Error('decode failed');
        return 'fine';
      },
    };
    const out = await ocrRegions(flaky, [rect(0), rect(1), rect(2)]);
    expect(out.unreadRegions).toHaveLength(1);
    expect(out.unreadRegions[0].x).toBe(10);
  });

  it('masks every region whole when there is no OCR engine at all', async () => {
    const regions = [rect(0), rect(1), rect(2)];
    const out = await ocrRegions(null, regions);
    expect(out.unavailable).toBeTruthy();
    expect(out.regions).toHaveLength(0);
    expect(rectsToMask(out)).toEqual(regions);
  });

  it('has nothing to mask when there are no image regions', async () => {
    const out = await ocrRegions(null, []);
    expect(out.ocrTruncated).toBe(false);
    expect(rectsToMask(out)).toEqual([]);
  });
});

describe('rectsToMask', () => {
  it('masks a region containing an Aadhaar number but not a clean one', async () => {
    const out = await ocrRegions(
      engineOf(['Order #234567890123 shipped', 'AADHAAR 2345 6789 0124']),
      [rect(0), rect(1)],
    );
    const masked = rectsToMask(out);
    expect(masked).toHaveLength(1);
    expect(masked[0].x).toBe(10);
    expect(out.regions.find((r) => r.isPII)?.kind).toBe('aadhaar');
  });
});

describe('collectImageRegions', () => {
  function build(html: string) {
    document.body.innerHTML = html;
    // jsdom reports zero-sized rects; stub geometry per element.
    for (const el of document.body.querySelectorAll<HTMLElement>('[data-rect]')) {
      const [x, y, w, h] = el.dataset.rect!.split(',').map(Number);
      el.getBoundingClientRect = () => ({
        x, y, width: w, height: h, left: x, top: y,
        right: x + w, bottom: y + h, toJSON: () => ({}),
      }) as DOMRect;
    }
  }

  it('collects content-sized images and canvases', () => {
    build('<img data-rect="0,0,200,200"><canvas data-rect="10,10,300,200"></canvas>');
    const regions = collectImageRegions();
    expect(regions.map((r) => r.kind).sort()).toEqual(['canvas', 'img']);
  });

  it('skips icons below the minimum size', () => {
    build(`<img data-rect="0,0,${MIN_REGION_PX - 1},200">`);
    expect(collectImageRegions()).toHaveLength(0);
  });

  it('skips images scrolled out of the viewport, which the capture does not contain', () => {
    build('<img data-rect="0,-500,200,200">');
    expect(collectImageRegions()).toHaveLength(0);
  });

  it('clips a partially visible image to the viewport', () => {
    build('<img data-rect="-50,0,200,200">');
    const [r] = collectImageRegions();
    expect(r.bbox.x).toBe(0);
    expect(r.bbox.width).toBe(150);
  });
});

describe('language configuration', () => {
  it('reads Hindi as well as English', () => {
    // Indic script support is the differentiator; it should be impossible to
    // silently regress to eng-only.
    expect(OCR_LANGS).toBe('eng+hin');
  });
});
