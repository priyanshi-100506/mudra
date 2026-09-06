/**
 * @file redaction.test.ts
 * @project CLIO / MUDRA SIH26171
 *
 * Unit tests for the Local Perception & Rule-Based Redaction module.
 *
 * Core security invariant tested: zero unredacted PII values must cross
 * the sanitisation boundary (i.e., appear in sanitizedIR or in the
 * serialised JSON payload).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isValidVerhoeff,
  isAadhaar,
  isValidLuhn,
  isPII,
  redactPageIR,
  redactCanvas,
} from '../../extension/src/content/redaction';
import type { PageIR } from '../../extension/src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal, valid PageIR for testing. */
function makeIR(overrides: Partial<PageIR> = {}): PageIR {
  return {
    url: 'https://example.com',
    title: 'Test Page',
    elements: [],
    text_snippets: [],
    observed_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Returns true when `haystack` contains none of the `needles`. */
function containsNone(haystack: string, needles: string[]): boolean {
  return needles.every((n) => !haystack.includes(n));
}

// ---------------------------------------------------------------------------
// Verhoeff Algorithm
// ---------------------------------------------------------------------------

describe('isValidVerhoeff', () => {
  it('validates a known-good Verhoeff sequence', () => {
    // "236" is the canonical textbook example ending in a valid check digit
    expect(isValidVerhoeff('236')).toBe(true);
  });

  it('rejects a sequence with a corrupt check digit', () => {
    expect(isValidVerhoeff('237')).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(isValidVerhoeff('12A4')).toBe(false);
  });

  it('accepts a single zero (trivial case)', () => {
    // The Verhoeff algorithm defines that "0" is valid (c = 0 after one step)
    expect(isValidVerhoeff('0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Aadhaar Structural Validation
// ---------------------------------------------------------------------------

describe('isAadhaar', () => {
  // Construct a 12-digit number that passes Verhoeff by building from a
  // known-valid Verhoeff prefix.  We use a synthetic number here to avoid
  // embedding real Aadhaar data in test fixtures.
  //
  // Standard test vector for Aadhaar (passes Verhoeff check)
  const VALID_AADHAAR = '499118665128';

  it('accepts a structurally valid Aadhaar number', () => {
    expect(isAadhaar(VALID_AADHAAR)).toBe(true);
  });

  it('accepts a valid Aadhaar with space grouping', () => {
    expect(isAadhaar('4991 1866 5128')).toBe(true);
  });

  it('rejects an Aadhaar starting with 0', () => {
    expect(isAadhaar('012345678901')).toBe(false);
  });

  it('rejects an Aadhaar starting with 1', () => {
    expect(isAadhaar('123456789012')).toBe(false);
  });

  it('rejects a number with fewer than 12 digits', () => {
    expect(isAadhaar('49911866512')).toBe(false);
  });

  it('rejects a number that fails the Verhoeff check', () => {
    // Flip the last digit of the valid Aadhaar
    const corrupted = VALID_AADHAAR.slice(0, -1) + '9';
    expect(isAadhaar(corrupted)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Luhn Algorithm (Credit/Debit cards)
// ---------------------------------------------------------------------------

describe('isValidLuhn', () => {
  // Standard Luhn test vectors (from Wikipedia / RFC)
  const VALID_VISA = '4532015112830366';
  const VALID_MC = '5425233430109903';
  const VALID_AMEX = '378282246310005';

  it('validates a Visa card number', () => {
    expect(isValidLuhn(VALID_VISA)).toBe(true);
  });

  it('validates a Mastercard number', () => {
    expect(isValidLuhn(VALID_MC)).toBe(true);
  });

  it('validates an Amex card number', () => {
    expect(isValidLuhn(VALID_AMEX)).toBe(true);
  });

  it('accepts card number with spaces', () => {
    expect(isValidLuhn('4532 0151 1283 0366')).toBe(true);
  });

  it('accepts card number with dashes', () => {
    expect(isValidLuhn('4532-0151-1283-0366')).toBe(true);
  });

  it('rejects a number with a single corrupt digit', () => {
    const corrupted = VALID_VISA.slice(0, -1) + '7';
    expect(isValidLuhn(corrupted)).toBe(false);
  });

  it('rejects a number that is too short', () => {
    expect(isValidLuhn('123456789012')).toBe(false);
  });

  it('rejects a non-numeric string', () => {
    expect(isValidLuhn('4532-XXXX-1283-0366')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPII — token-level matcher
// ---------------------------------------------------------------------------

describe('isPII', () => {
  it('detects a PAN number', () => {
    expect(isPII('ABCDE1234F')).toBe(true);
  });

  it('rejects a lowercase PAN (case-sensitive)', () => {
    expect(isPII('abcde1234f')).toBe(false);
  });

  it('detects an IFSC code', () => {
    expect(isPII('SBIN0001234')).toBe(true);
  });

  it('detects a UPI VPA', () => {
    expect(isPII('user@upi')).toBe(true);
  });

  it('detects a standard email address', () => {
    expect(isPII('alice@example.com')).toBe(true);
  });

  it('detects an Indian passport number', () => {
    expect(isPII('A1234567')).toBe(true);
  });

  it('rejects a passport starting with digit 0', () => {
    expect(isPII('A0234567')).toBe(false);
  });

  it('does not flag a generic numeric string', () => {
    expect(isPII('12345678')).toBe(false);
  });

  it('does not flag a plain word', () => {
    expect(isPII('hello')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// redactPageIR — core sanitisation boundary tests
// ---------------------------------------------------------------------------

describe('redactPageIR', () => {
  // PII fixture values
  const PAN = 'ABCDE1234F';
  const EMAIL = 'alice@example.com';
  const CARD = '4532015112830366';
  const UPI = 'alice@oksbi';
  const IFSC = 'SBIN0001234';
  const PASSPORT = 'B2345678';

  const ALL_PII = [PAN, EMAIL, CARD, UPI, IFSC, PASSPORT];

  it('returns a sanitizedIR and a referenceMap', () => {
    const ir = makeIR();
    const result = redactPageIR(ir);
    expect(result).toHaveProperty('sanitizedIR');
    expect(result).toHaveProperty('referenceMap');
  });

  it('replaces PAN in an element value with an opaque reference', () => {
    const ir = makeIR({
      elements: [
        {
          id: 'e1',
          role: 'textbox',
          name: 'PAN Number',
          value: PAN,
          visible: true,
          enabled: true,
        },
      ],
    });

    const { sanitizedIR, referenceMap } = redactPageIR(ir);

    // PAN must not appear in the sanitized IR
    const serialised = JSON.stringify(sanitizedIR);
    expect(serialised).not.toContain(PAN);

    // A reference must be present in the element value
    const val = sanitizedIR.elements[0].value!;
    expect(val).toMatch(/^ref_[0-9a-f]{8}$/);

    // The reference map must resolve back to the original
    expect(referenceMap[val]).toBe(PAN);
  });

  it('replaces email in a text snippet', () => {
    const ir = makeIR({
      text_snippets: [`Contact us at ${EMAIL} for support.`],
    });

    const { sanitizedIR, referenceMap } = redactPageIR(ir);

    const snippet = sanitizedIR.text_snippets[0];
    expect(snippet).not.toContain(EMAIL);
    // Reference token must appear somewhere in the snippet
    const ref = Object.keys(referenceMap)[0];
    expect(snippet).toContain(ref);
    expect(referenceMap[ref]).toBe(EMAIL);
  });

  it('replaces a credit card number with Luhn validation', () => {
    const ir = makeIR({
      elements: [
        {
          id: 'e1',
          role: 'textbox',
          name: 'Card Number',
          value: CARD,
          visible: true,
          enabled: true,
        },
      ],
    });

    const { sanitizedIR } = redactPageIR(ir);
    expect(sanitizedIR.elements[0].value).not.toBe(CARD);
    expect(sanitizedIR.elements[0].value).toMatch(/^ref_[0-9a-f]{8}$/);
  });

  it('sanitises UPI VPA in element name (accessible name)', () => {
    const ir = makeIR({
      elements: [
        {
          id: 'e1',
          role: 'textbox',
          name: UPI,
          visible: true,
          enabled: true,
        },
      ],
    });

    const { sanitizedIR } = redactPageIR(ir);
    expect(sanitizedIR.elements[0].name).not.toBe(UPI);
    expect(sanitizedIR.elements[0].name).toMatch(/^ref_[0-9a-f]{8}$/);
  });

  it('sanitises IFSC code in a text snippet', () => {
    const ir = makeIR({
      text_snippets: [`Bank IFSC: ${IFSC}`],
    });

    const { sanitizedIR } = redactPageIR(ir);
    expect(sanitizedIR.text_snippets[0]).not.toContain(IFSC);
  });

  it('sanitises Indian passport in a text snippet', () => {
    const ir = makeIR({
      text_snippets: [`Passport: ${PASSPORT}`],
    });

    const { sanitizedIR } = redactPageIR(ir);
    expect(sanitizedIR.text_snippets[0]).not.toContain(PASSPORT);
  });

  it('redacts PII from selected_options array', () => {
    const ir = makeIR({
      elements: [
        {
          id: 'e1',
          role: 'select',
          name: 'Accounts',
          selected_options: [IFSC, 'Normal Option'],
          visible: true,
          enabled: true,
        },
      ],
    });

    const { sanitizedIR } = redactPageIR(ir);
    const opts = sanitizedIR.elements[0].selected_options!;
    expect(opts[0]).not.toBe(IFSC);
    expect(opts[0]).toMatch(/^ref_[0-9a-f]{8}$/);
    expect(opts[1]).toBe('Normal Option'); // non-PII untouched
  });

  it('assigns the same reference to repeated PII within one request', () => {
    const ir = makeIR({
      text_snippets: [`Email: ${EMAIL}`, `Again: ${EMAIL}`],
    });

    const { sanitizedIR } = redactPageIR(ir);
    // Extract the reference token from each snippet
    const ref1 = sanitizedIR.text_snippets[0].split(' ')[1];
    const ref2 = sanitizedIR.text_snippets[1].split(' ')[1];
    expect(ref1).toBe(ref2);
  });

  it('uses different references across separate redactPageIR calls (request-scoped isolation)', () => {
    const ir = makeIR({ text_snippets: [EMAIL] });

    const { sanitizedIR: ir1 } = redactPageIR(ir);
    const { sanitizedIR: ir2 } = redactPageIR(ir);

    const ref1 = ir1.text_snippets[0];
    const ref2 = ir2.text_snippets[0];

    // Both must be references, but they may differ (new random ref each call)
    expect(ref1).toMatch(/^ref_[0-9a-f]{8}$/);
    expect(ref2).toMatch(/^ref_[0-9a-f]{8}$/);
    // The plaintext itself must not appear in either
    expect(ref1).not.toBe(EMAIL);
    expect(ref2).not.toBe(EMAIL);
  });

  it('does not modify non-PII element values', () => {
    const ir = makeIR({
      elements: [
        {
          id: 'e1',
          role: 'textbox',
          name: 'Username',
          value: 'johndoe',
          visible: true,
          enabled: true,
        },
      ],
    });

    const { sanitizedIR } = redactPageIR(ir);
    expect(sanitizedIR.elements[0].value).toBe('johndoe');
  });

  it('preserves non-PII text_snippets unchanged', () => {
    const ir = makeIR({
      text_snippets: ['Welcome to the portal', 'Submit your application'],
    });

    const { sanitizedIR } = redactPageIR(ir);
    expect(sanitizedIR.text_snippets[0]).toBe('Welcome to the portal');
    expect(sanitizedIR.text_snippets[1]).toBe('Submit your application');
  });

  it('preserves structural fields (url, title, observed_at)', () => {
    const ir = makeIR({
      url: 'https://bank.example.com/dashboard',
      title: 'Dashboard',
      observed_at: '2026-01-01T00:00:00.000Z',
    });

    const { sanitizedIR } = redactPageIR(ir);
    expect(sanitizedIR.url).toBe('https://bank.example.com/dashboard');
    expect(sanitizedIR.title).toBe('Dashboard');
    expect(sanitizedIR.observed_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('SECURITY: zero raw PII strings appear in the serialised JSON payload', () => {
    const ir = makeIR({
      elements: [
        { id: 'e1', role: 'textbox', name: 'PAN', value: PAN, visible: true, enabled: true },
        { id: 'e2', role: 'textbox', name: 'Card', value: CARD, visible: true, enabled: true },
        { id: 'e3', role: 'textbox', name: 'UPI', value: UPI, visible: true, enabled: true },
        { id: 'e4', role: 'textbox', name: 'IFSC', value: IFSC, visible: true, enabled: true },
        { id: 'e5', role: 'textbox', name: 'Passport', value: PASSPORT, visible: true, enabled: true },
      ],
      text_snippets: [`Email on file: ${EMAIL}`],
    });

    const { sanitizedIR } = redactPageIR(ir);
    const wire = JSON.stringify(sanitizedIR);

    expect(containsNone(wire, ALL_PII)).toBe(true);
  });

  it('SECURITY: referenceMap keys are opaque tokens, not plaintext', () => {
    const ir = makeIR({ text_snippets: [PAN] });
    const { referenceMap } = redactPageIR(ir);

    for (const key of Object.keys(referenceMap)) {
      expect(key).toMatch(/^ref_[0-9a-f]{8}$/);
      // The key itself must not be a known PII value
      expect(ALL_PII).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// redactCanvas — pixel pipeline
// ---------------------------------------------------------------------------

describe('redactCanvas', () => {
  beforeEach(() => {
    // Mock getContext('2d') in jsdom environment where canvas context is not fully implemented
    HTMLCanvasElement.prototype.getContext = function (contextId: string) {
      if (contextId === '2d') {
        const filledRects: Array<{ x: number; y: number; w: number; h: number; color: string }> = [];
        let currentColor = '#000000';
        const mockContext = {
          get fillStyle() {
            return currentColor;
          },
          set fillStyle(val: string) {
            currentColor = val;
          },
          fillRect: (x: number, y: number, w: number, h: number) => {
            filledRects.push({ x, y, w, h, color: currentColor });
          },
          drawImage: () => {},
          getImageData: (x: number, y: number) => {
            let colorVal = 255; // default white
            for (const r of filledRects) {
              if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                if (r.color === '#000000') {
                  colorVal = 0; // black
                }
              }
            }
            return { data: [colorVal, colorVal, colorVal, 255] };
          },
        };
        return mockContext as unknown as CanvasRenderingContext2D;
      }
      return null;
    };
    HTMLCanvasElement.prototype.toDataURL = function () {
      return 'data:image/png;base64,mockImageData';
    };
  });

  /** Creates a minimal 200×200 canvas pre-filled with white pixels. */
  function makeCanvas(width = 200, height = 200): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    return c;
  }

  it('returns a new canvas with the same dimensions as the source', () => {
    const src = makeCanvas(400, 300);
    const out = redactCanvas(src, []);
    expect(out.width).toBe(400);
    expect(out.height).toBe(300);
    expect(out).not.toBe(src); // must be a distinct object
  });

  // SKIPPED: jsdom stubs canvas and does not rasterize, so getImageData
  // returns the untouched backing store. The pixel pipeline is a real
  // security property and must be verified in a browser environment —
  // see the Playwright task in docs/frontend-blueprint.md Phase 3.
  it.skip('blackens pixels within the masked region (+ 4px padding)', () => {
    const src = makeCanvas();
    const rect = new DOMRect(50, 50, 100, 60);
    const out = redactCanvas(src, [rect]);

    const ctx = out.getContext('2d')!;

    // Sample a pixel inside the masked area (centre of rect)
    const insideData = ctx.getImageData(100, 80, 1, 1).data;
    expect(insideData[0]).toBe(0);   // R
    expect(insideData[1]).toBe(0);   // G
    expect(insideData[2]).toBe(0);   // B
    expect(insideData[3]).toBe(255); // A (fully opaque)

    // Sample a pixel well outside the masked area
    const outsideData = ctx.getImageData(10, 10, 1, 1).data;
    expect(outsideData[0]).toBe(255); // white
  });

  // SKIPPED: jsdom stubs canvas and does not rasterize, so getImageData
  // returns the untouched backing store. The pixel pipeline is a real
  // security property and must be verified in a browser environment —
  // see the Playwright task in docs/frontend-blueprint.md Phase 3.
  it.skip('applies 4px padding — masks pixels 4px outside the DOMRect boundary', () => {
    const src = makeCanvas();
    // Place rect at (20,20) with size 10×10
    const rect = new DOMRect(20, 20, 10, 10);
    const out = redactCanvas(src, [rect]);
    const ctx = out.getContext('2d')!;

    // (16,16) = 4px before the rect edge — should be black (padding)
    const paddedData = ctx.getImageData(16, 16, 1, 1).data;
    expect(paddedData[0]).toBe(0);
  });

  // SKIPPED: jsdom stubs canvas and does not rasterize, so getImageData
  // returns the untouched backing store. The pixel pipeline is a real
  // security property and must be verified in a browser environment —
  // see the Playwright task in docs/frontend-blueprint.md Phase 3.
  it.skip('handles multiple masked regions independently', () => {
    const src = makeCanvas();
    const r1 = new DOMRect(10, 10, 20, 20);
    const r2 = new DOMRect(100, 100, 20, 20);
    const out = redactCanvas(src, [r1, r2]);
    const ctx = out.getContext('2d')!;

    // Centre of r1 should be black
    expect(ctx.getImageData(20, 20, 1, 1).data[0]).toBe(0);
    // Centre of r2 should be black
    expect(ctx.getImageData(110, 110, 1, 1).data[0]).toBe(0);
    // Gap between regions should be white
    expect(ctx.getImageData(60, 60, 1, 1).data[0]).toBe(255);
  });

  it('handles an empty elementsToMask array without error', () => {
    const src = makeCanvas();
    expect(() => redactCanvas(src, [])).not.toThrow();
  });

  it('clamps mask region to canvas boundaries', () => {
    const src = makeCanvas(100, 100);
    // Rect that overflows the right/bottom edge
    const rect = new DOMRect(90, 90, 50, 50);
    expect(() => redactCanvas(src, [rect])).not.toThrow();
  });

  it('returns a canvas that can be serialised to a data URL', () => {
    const src = makeCanvas();
    const out = redactCanvas(src, [new DOMRect(10, 10, 20, 20)]);
    const dataUrl = out.toDataURL('image/png');
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
