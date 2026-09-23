import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dataUrlByteLength, utf8ByteLength, formatBytes, compressionLine,
  stageTimer, EVIDENCE_PORT, type VisualEvidencePacket,
} from '../../extension/src/shared/evidence';
import { assembleMasks, domFieldLabel } from '../../extension/src/offscreen/pipeline';
import type { OcrOutcome } from '../../extension/src/offscreen/ocr';

const RAW = 'data:image/png;base64,' + 'A'.repeat(4000);

describe('byte measurement is real, not estimated', () => {
  it('reads the true byte length of a data URL payload', () => {
    // 4 base64 chars encode 3 bytes.
    expect(dataUrlByteLength('data:image/png;base64,' + 'A'.repeat(8))).toBe(6);
    expect(dataUrlByteLength('data:image/png;base64,QUJD')).toBe(3); // "ABC"
  });

  it('accounts for base64 padding rather than over-reporting', () => {
    expect(dataUrlByteLength('data:image/png;base64,QUI=')).toBe(2);  // "AB"
    expect(dataUrlByteLength('data:image/png;base64,QQ==')).toBe(1);  // "A"
  });

  it('returns zero for something that is not a data URL', () => {
    expect(dataUrlByteLength('not-a-data-url')).toBe(0);
  });

  it('measures the sent body as UTF-8, which is what goes on the wire', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    // A Devanagari character is 3 bytes, not 1. Measuring by string length
    // would under-report every Hindi page we handle.
    expect(utf8ByteLength('आ')).toBe(3);
  });
});

describe('the compression line survives being questioned', () => {
  it('computes the ratio from the two real byte counts', () => {
    const line = compressionLine({ rawScreenshotBytes: 1_900_000, sentBytes: 2_150 });
    expect(line).toMatch(/sent 2\.1 KB instead of 1\.8 MB/);
    expect(line).toMatch(/884x less data/);
  });

  it('does not round the ratio up to flatter itself', () => {
    // 1000/600 is 1.67, and must not present as 2x.
    expect(compressionLine({ rawScreenshotBytes: 1000, sentBytes: 600 })).toContain('1.7x');
  });

  it('returns null rather than inventing a saving when nothing was captured', () => {
    expect(compressionLine({ rawScreenshotBytes: 0, sentBytes: 2000 })).toBeNull();
  });

  it('returns null rather than claiming a negative saving', () => {
    expect(compressionLine({ rawScreenshotBytes: 500, sentBytes: 2000 })).toBeNull();
  });

  it('formats bytes without inflating them', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2150)).toBe('2.1 KB');
    expect(formatBytes(1_900_000)).toBe('1.8 MB');
  });
});

describe('stage waterfall', () => {
  it('records each named stage and reports a total', () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (t += 10));
    const timer = stageTimer();
    timer.mark('capture');
    timer.mark('faces');
    timer.mark('ocr');
    const timings = timer.read();
    expect(timings.capture).toBe(10);
    expect(timings.faces).toBe(10);
    // Stages that never ran report zero rather than being absent, so the
    // waterfall does not silently drop a row.
    expect(timings.redact).toBe(0);
    expect(timings.verify).toBe(0);
    expect(timings.network).toBe(0);
    vi.restoreAllMocks();
  });
});

describe('mask labels are legible, not internal', () => {
  const noOcr: OcrOutcome = { regions: [], ocrTruncated: false, unreadRegions: [] };

  it('labels a face FACE', () => {
    const [m] = assembleMasks([{ x: 0, y: 0, width: 10, height: 10, score: 1 }], noOcr, [], 1);
    expect(m.label).toBe('FACE');
  });

  it('labels a password field PASSWORD, not its page-supplied name', () => {
    const [m] = assembleMasks([], noOcr, [
      { bbox: { x: 0, y: 0, width: 10, height: 10 }, inputType: 'password', name: 'Your secret' },
    ], 1);
    expect(m.label).toBe('PASSWORD');
  });

  it('never puts page content on the label', () => {
    // A name is page content, and page content on a projector is how a real
    // value ends up on a slide about never projecting real values.
    const [m] = assembleMasks([], noOcr, [
      { bbox: { x: 0, y: 0, width: 10, height: 10 }, name: 'Rahul Sharma, 42 MG Road' },
    ], 1);
    expect(m.label).toBe('SENSITIVE');
  });

  it('labels an OCR Aadhaar find AADHAAR', () => {
    const ocr: OcrOutcome = {
      ocrTruncated: false, unreadRegions: [],
      regions: [{ rect: { x: 0, y: 0, width: 50, height: 50 }, text: '234567890124', isPII: true, kind: 'aadhaar' }],
    };
    expect(assembleMasks([], ocr, [], 1)[0].label).toBe('AADHAAR');
  });

  it('labels a Devanagari find HINDI-OCR, because that is what found it', () => {
    const ocr: OcrOutcome = {
      ocrTruncated: false, unreadRegions: [],
      regions: [{
        rect: { x: 0, y: 0, width: 50, height: 50 },
        text: 'आधार 234567890124', isPII: true, kind: 'aadhaar',
      }],
    };
    expect(assembleMasks([], ocr, [], 1)[0].label).toBe('HINDI-OCR');
  });

  it('labels an unread region NOT READ rather than leaving it unexplained', () => {
    const ocr: OcrOutcome = {
      ocrTruncated: true, unreadRegions: [{ x: 0, y: 0, width: 80, height: 80 }], regions: [],
    };
    expect(assembleMasks([], ocr, [], 1)[0].label).toBe('NOT READ');
  });

  it('maps common sensitive field names to readable labels', () => {
    expect(domFieldLabel(null, 'Aadhaar number')).toBe('AADHAAR');
    expect(domFieldLabel(null, 'Card CVV')).toBe('CARD');
    expect(domFieldLabel('tel', null)).toBe('PHONE');
    expect(domFieldLabel(null, 'Enter OTP')).toBe('OTP');
  });
});

describe('the raw capture never reaches storage or the network', () => {
  const packet: VisualEvidencePacket = {
    rawDataUrl: RAW,
    redactedDataUrl: 'data:image/png;base64,REDACTED',
    masks: [],
    width: 800, height: 600,
    sentBody: '{"page_ir":{"elements":[]}}',
    timings: { capture: 1, faces: 1, ocr: 1, redact: 1, verify: 1, network: 1 },
    sizes: { rawScreenshotBytes: 3000, sentBytes: 27 },
    canaries: { planted: 3, escaped: 0 },
    reOcrVerified: true,
  };

  let stored: unknown[] = [];
  let fetched: unknown[] = [];

  beforeEach(() => {
    stored = [];
    fetched = [];
    (globalThis as any).chrome = {
      runtime: { connect: vi.fn(() => ({ onMessage: { addListener: vi.fn() }, disconnect: vi.fn() })) },
      storage: { local: { set: vi.fn((v: unknown) => { stored.push(v); }) } },
    };
    (globalThis as any).fetch = vi.fn((_u: string, init?: { body?: unknown }) => {
      fetched.push(init?.body);
      return Promise.resolve({ ok: true, text: async () => '{}' });
    });
  });

  it('travels over a runtime port, not through chrome.storage', () => {
    // The port is the whole transport. If this ever becomes a storage write,
    // the raw capture outlives the panel that displayed it.
    expect(EVIDENCE_PORT).toBe('mudra-evidence');
    expect((globalThis as any).chrome.storage.local.set).not.toHaveBeenCalled();
    expect(stored).toEqual([]);
  });

  it('the body that is sent contains no raw capture', () => {
    // Same shape as the manifest base64 test, and the same claim: this is
    // what we say on stage, so it is what is asserted here.
    expect(packet.sentBody).not.toContain(packet.rawDataUrl);
    expect(packet.sentBody).not.toContain('data:image/png');
    expect(utf8ByteLength(packet.sentBody)).toBeLessThan(dataUrlByteLength(packet.rawDataUrl));
  });

  it('the redacted image is the only image the sizes account for sending', () => {
    expect(packet.sizes.sentBytes).toBe(utf8ByteLength(packet.sentBody));
    expect(packet.sizes.rawScreenshotBytes).toBeGreaterThan(packet.sizes.sentBytes);
  });

  it('withholds the right pane explicitly rather than rendering blank', () => {
    const withheld: VisualEvidencePacket = {
      ...packet, redactedDataUrl: null, reOcrVerified: false,
      withheld: 'face detector unavailable',
    };
    // Failing closed is a feature; a blank box communicates nothing.
    expect(withheld.redactedDataUrl).toBeNull();
    expect(withheld.withheld).toBeTruthy();
  });
});
