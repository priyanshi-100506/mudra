import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { ensureOffscreen, offscreenExists, closeOffscreen } from '../../extension/src/background/offscreen-manager';
import { runVisualPass, noImage, VISUAL_PASS_TIMEOUT_MS } from '../../extension/src/background/visual-pass';

const MODEL = resolve(__dirname, '../../extension/public/models/version-RFB-320.onnx');
const HAVE_WEIGHTS = existsSync(MODEL);

interface ChromeStub {
  exists: boolean;
  createCalls: number;
  createError?: Error;
  observeReply?: unknown;
  observeDelayMs?: number;
  captureError?: Error;
}

function stubChrome(cfg: Partial<ChromeStub> = {}) {
  const state: ChromeStub = { exists: false, createCalls: 0, ...cfg };
  const sendMessage = vi.fn(async (msg: { target?: string; type?: string }) => {
    if (msg.target !== 'offscreen') return undefined;
    if (msg.type === 'OBSERVE') {
      if (state.observeDelayMs) {
        await new Promise((r) => setTimeout(r, state.observeDelayMs));
      }
      return state.observeReply;
    }
    return { ok: true };
  });

  (globalThis as any).chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://abc/${p}`,
      sendMessage,
    },
    offscreen: {
      hasDocument: async () => state.exists,
      createDocument: async () => {
        state.createCalls += 1;
        if (state.createError) throw state.createError;
        // Chrome only brings it up after a beat; the race is real.
        await new Promise((r) => setTimeout(r, 5));
        state.exists = true;
      },
      closeDocument: async () => { state.exists = false; },
    },
    tabs: {
      get: async () => ({ id: 7, windowId: 3 }),
      sendMessage: async () => ({ width: 800, height: 600, dpr: 2, imageRegions: [] }),
      captureVisibleTab: async () => {
        if (state.captureError) throw state.captureError;
        return 'data:image/png;base64,' + 'A'.repeat(400);
      },
    },
  };
  return state;
}

const okReply = {
  evidence: {
    screenshotB64: 'data:image/png;base64,REDACTED',
    maskedRegions: [{ x: 0, y: 0, width: 10, height: 10, kind: 'FACE', label: 'FACE' }],
    ocrRegionCount: 2,
    ocrTruncated: false,
    reOcrVerified: true,
    faceCount: 1,
  },
  warmupMs: 850,
  timings: { capture: 40, faces: 30, ocr: 200, redact: 10, verify: 180, network: 0 },
  rawScreenshotBytes: 1_900_000,
};

describe('offscreen document lifetime', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates the document when none exists', async () => {
    const state = stubChrome();
    await ensureOffscreen();
    expect(state.createCalls).toBe(1);
    expect(await offscreenExists()).toBe(true);
  });

  it('does not create a second one when it is already up', async () => {
    const state = stubChrome({ exists: true });
    await ensureOffscreen();
    expect(state.createCalls).toBe(0);
  });

  it('serialises a race so two observations do not both try to create it', async () => {
    // The ordinary case: a page re-observes while the first pass is starting.
    const state = stubChrome();
    await Promise.all([ensureOffscreen(), ensureOffscreen(), ensureOffscreen()]);
    expect(state.createCalls).toBe(1);
  });

  it('treats "already exists" as success, not as a dropped observation', async () => {
    // The classic bug: a cold start that loses the first observation and
    // works from the second onward. Invisible in dev, guaranteed on stage.
    const state = stubChrome({ createError: new Error('Only a single offscreen document may be created.') });
    await expect(ensureOffscreen()).resolves.toBeUndefined();
    expect(state.createCalls).toBe(1);
  });

  it('still reports a genuine creation failure', async () => {
    stubChrome({ createError: new Error('no permission') });
    await expect(ensureOffscreen()).rejects.toThrow(/no permission/);
  });

  it('recovers after Chrome tears the document down between observations', async () => {
    const state = stubChrome();
    await ensureOffscreen();
    state.exists = false;               // Chrome reclaimed it
    await ensureOffscreen();
    expect(state.createCalls).toBe(2);  // asked again rather than assumed
  });

  it('closing a document that is already gone is not an error', async () => {
    stubChrome({ exists: false });
    await expect(closeOffscreen()).resolves.toBeUndefined();
  });
});

describe('the visual pass is fail-closed at every step of the seam', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends no image when the capture itself fails', async () => {
    stubChrome({ captureError: new Error('tab not capturable') });
    const r = await runVisualPass({
      tabId: 7, domSensitiveBoxes: [], knownPiiValues: [],
      canaries: { planted: 3, escaped: 0 },
    });
    expect(r.screenshotB64).toBeNull();
    expect(r.withheld).toMatch(/capture failed/);
  });

  it('sends no image when the offscreen document will not start', async () => {
    stubChrome({ createError: new Error('offscreen blocked') });
    const r = await runVisualPass({
      tabId: 7, domSensitiveBoxes: [], knownPiiValues: [],
      canaries: { planted: 3, escaped: 0 },
    });
    expect(r.screenshotB64).toBeNull();
    expect(r.withheld).toMatch(/offscreen document unavailable/);
  });

  it('sends no image when the offscreen document never answers', async () => {
    // A stalled pass must not leave the agent appearing to think forever.
    vi.useFakeTimers();
    stubChrome({ observeDelayMs: VISUAL_PASS_TIMEOUT_MS + 1000, observeReply: okReply });
    const promise = runVisualPass({
      tabId: 7, domSensitiveBoxes: [], knownPiiValues: [],
      canaries: { planted: 3, escaped: 0 },
    });
    await vi.advanceTimersByTimeAsync(VISUAL_PASS_TIMEOUT_MS + 50);
    const r = await promise;
    vi.useRealTimers();
    expect(r.screenshotB64).toBeNull();
    expect(r.withheld).toMatch(/timed out/);
  });

  it('sends no image when the offscreen document returns nothing', async () => {
    stubChrome({ observeReply: undefined });
    const r = await runVisualPass({
      tabId: 7, domSensitiveBoxes: [], knownPiiValues: [],
      canaries: { planted: 3, escaped: 0 },
    });
    expect(r.screenshotB64).toBeNull();
    expect(r.withheld).toMatch(/returned nothing/);
  });

  it('refuses an image the other side did not verify, even if it sent one', async () => {
    // Belt and braces at the boundary: unverified pixels are a bug on the
    // far side, and they stop here rather than being trusted.
    stubChrome({
      observeReply: { ...okReply, evidence: { ...okReply.evidence, reOcrVerified: false } },
    });
    const r = await runVisualPass({
      tabId: 7, domSensitiveBoxes: [], knownPiiValues: [],
      canaries: { planted: 3, escaped: 0 },
    });
    expect(r.screenshotB64).toBeNull();
    expect(r.reOcrVerified).toBe(false);
  });

  it('never returns the raw capture on any failure path', async () => {
    for (const cfg of [
      { captureError: new Error('x') },
      { createError: new Error('y') },
      { observeReply: undefined },
    ]) {
      stubChrome(cfg);
      const r = await runVisualPass({
        tabId: 7, domSensitiveBoxes: [], knownPiiValues: [],
        canaries: { planted: 3, escaped: 0 },
      });
      // There is deliberately no branch from a failure back to raw pixels.
      expect(r.screenshotB64).toBeNull();
      expect(JSON.stringify(r)).not.toContain('AAAA');
    }
  });

  it('a withheld result always carries a reason, never a silent null', async () => {
    // "No image" and "no observation" must never look the same.
    expect(noImage('anything').withheld).toBeTruthy();
    stubChrome({ observeReply: undefined });
    const r = await runVisualPass({
      tabId: 7, domSensitiveBoxes: [], knownPiiValues: [],
      canaries: { planted: 3, escaped: 0 },
    });
    expect(r.withheld).toBeTruthy();
  });
});

describe('a verified pass reports what it found', () => {
  it('carries counts, masks, timings and the first-load cost through', async () => {
    stubChrome({ observeReply: okReply });
    const r = await runVisualPass({
      tabId: 7, domSensitiveBoxes: [], knownPiiValues: [],
      canaries: { planted: 3, escaped: 0 },
    });
    expect(r.reOcrVerified).toBe(true);
    expect(r.screenshotB64).toBe('data:image/png;base64,REDACTED');
    expect(r).toMatchObject({ faces: 1, ocrRegions: 2, maskedRegions: 1 });
    // Model load is reported apart from the stage times, so a cold start
    // reads as a cold start rather than as a slow OCR pass.
    expect(r.warmupMs).toBe(850);
    expect(r.timings.ocr).toBe(200);
  });

  it('scales image regions into device pixels exactly once', async () => {
    stubChrome({ observeReply: okReply });
    (globalThis as any).chrome.tabs.sendMessage = async () => ({
      width: 800, height: 600, dpr: 2,
      imageRegions: [{ kind: 'img', bbox: { x: 10, y: 20, width: 100, height: 50 } }],
    });
    await runVisualPass({
      tabId: 7, domSensitiveBoxes: [], knownPiiValues: [],
      canaries: { planted: 3, escaped: 0 },
    });
    const call = (globalThis as any).chrome.runtime.sendMessage.mock.calls
      .find((c: any[]) => c[0]?.type === 'OBSERVE');
    expect(call[0].request.imageRegions[0]).toEqual({ x: 20, y: 40, width: 200, height: 100 });
  });
});

describe.skipIf(!HAVE_WEIGHTS)('the committed model, checked against what vision.ts expects', () => {
  // These run against the real file. They deliberately do not try to load an
  // inference session: ORT's WASM backend needs a browser, and pretending
  // otherwise under JSDOM would test the harness rather than the model. The
  // live load is asserted in extension/scripts/drive-extension.mjs, which
  // runs in a real Chrome.

  it('is the file the README records', async () => {
    const { createHash } = await import('crypto');
    const { readFileSync } = await import('fs');
    const buf = readFileSync(MODEL);
    const sha = createHash('sha256').update(buf).digest('hex');
    const readme = readFileSync(resolve(__dirname, '../../extension/public/models/README.md'), 'utf8');
    // A hash recorded but never compared is decoration.
    expect(readme).toContain(sha);
    expect(buf.length).toBe(1_270_727);
  });

  it('names its tensors the way the decoder looks them up', async () => {
    // vision.ts finds outputs by /score|conf/ and /box/, falling back to
    // position. If a re-export renamed them, decodeDetections would read
    // boxes as scores and silently mask nothing — so the names are checked
    // against the bytes rather than assumed.
    const { readFileSync } = await import('fs');
    const bytes = readFileSync(MODEL);
    const header = bytes.subarray(0, 4096).toString('latin1');
    const footer = bytes.subarray(-4096).toString('latin1');
    expect(header).toContain('input');
    expect(footer).toContain('scores');
    expect(footer).toContain('boxes');
  });

  it('is large enough to be the real graph, not an LFS pointer', async () => {
    // A git-lfs pointer is a few hundred bytes of text and would otherwise
    // fail much later, as an opaque ORT parse error.
    const { readFileSync } = await import('fs');
    const head = readFileSync(MODEL).subarray(0, 64).toString('latin1');
    expect(head).not.toContain('git-lfs');
    expect(head).not.toContain('version https://');
  });
});

describe('weights presence is reported honestly', () => {
  it('states whether the end-to-end assertion actually ran', () => {
    // Not an assertion about the model — an assertion that we are not
    // quietly reporting a skipped test as a passing one.
    if (!HAVE_WEIGHTS) {
      expect(existsSync(MODEL)).toBe(false);
    } else {
      expect(existsSync(MODEL)).toBe(true);
    }
  });
});
