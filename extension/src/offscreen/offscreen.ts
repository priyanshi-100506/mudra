/**
 * Offscreen entry point — where the pixels live.
 *
 * The service worker owns the pipeline; this document owns the image. The
 * split exists because a worker cannot decode an image or run WASM inference,
 * and keeping the capture on this side means it never passes through the code
 * that talks to the network.
 *
 * The raw capture crosses a context boundary exactly twice: once from the
 * worker to here, and once from here to the panel, and the second only when
 * somebody has the panel open. Chrome's runtime messaging serialises to JSON,
 * so an ImageBitmap cannot be transferred across it — what crosses is the
 * data URL, converted to a bitmap here and discarded when the observation
 * ends. Routing it back and forth instead would spend most of the latency
 * budget re-encoding the same PNG.
 */
import { initVision, visionStatus } from './vision';
import { initOcr, tesseractEngine } from './tesseract-engine';
import { analyseCapture, type VisualEvidence, type DomSensitiveBox } from './pipeline';
import { redactCanvas } from '../content/redaction';
import { EVIDENCE_PORT, stageTimer, dataUrlByteLength, type VisualEvidencePacket }
  from '../shared/evidence';
import type { ImageRect } from '../shared/geometry';

/**
 * Model load is paid once, not per observation.
 *
 * Kept alive across observations deliberately: reloading a 1.2 MB graph and a
 * Tesseract worker on every page would dominate the per-observation cost and
 * would make the "runs on an 8 GB laptop" claim untestable, because the
 * steady-state number is the one that claim is about. The first-load cost is
 * reported separately in the waterfall rather than folded into stage times,
 * so a cold start reads as a cold start.
 */
let warmupMs: number | null = null;
let warming: Promise<void> | null = null;

async function ensureWarm(): Promise<void> {
  if (warmupMs !== null) return;
  if (warming) return warming;
  warming = (async () => {
    const t0 = performance.now();
    // Both are fail-closed on their own terms: vision returns ready:false,
    // OCR returns a null engine, and each of those already means "mask more,
    // send less" rather than "carry on regardless".
    await Promise.all([initVision(), initOcr()]);
    warmupMs = Math.round(performance.now() - t0);
    warming = null;
  })();
  return warming;
}

/** Panel connections. The raw capture goes here and nowhere else. */
const panels = new Set<chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== EVIDENCE_PORT) return;
  panels.add(port);
  port.onDisconnect.addListener(() => panels.delete(port));
});

function publishToPanels(packet: VisualEvidencePacket): void {
  for (const port of panels) {
    try { port.postMessage(packet); } catch { panels.delete(port); }
  }
}

async function bitmapFrom(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

function canvasOf(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('offscreen: no 2D context for the capture.');
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

async function encode(canvas: HTMLCanvasElement): Promise<string> {
  return canvas.toDataURL('image/png');
}

export interface ObserveRequest {
  dataUrl: string;
  dpr: number;
  imageRegions: ImageRect[];
  domSensitiveBoxes: DomSensitiveBox[];
  knownPiiValues: string[];
  canaryText?: string;
  /** Counts for the panel line; the values themselves never come here. */
  canaries: { planted: number; escaped: number };
}

export interface ObserveResult {
  evidence: Omit<VisualEvidence, 'faces'> & { faceCount: number };
  warmupMs: number;
  timings: ReturnType<ReturnType<typeof stageTimer>['read']>;
  rawScreenshotBytes: number;
}

/**
 * One observation's visual pass.
 *
 * Every throw is converted to a withheld result before it leaves this
 * function. A failure here must land in "no image sent", never in "no
 * observation happened" — a silently dropped observation looks identical to a
 * clean page, which is the one confusion this system cannot afford.
 */
async function observe(req: ObserveRequest): Promise<ObserveResult> {
  const timer = stageTimer();
  await ensureWarm();

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await bitmapFrom(req.dataUrl);
    timer.mark('capture');

    const evidence = await analyseCapture({
      bitmap,
      dpr: req.dpr,
      imageRegions: req.imageRegions,
      domSensitiveBoxes: req.domSensitiveBoxes,
      knownPiiValues: req.knownPiiValues,
      canaryText: req.canaryText,
      ocrEngine: tesseractEngine(bitmap),
      reOcr: async (canvas) => {
        const engine = tesseractEngine(await createImageBitmap(canvas));
        if (!engine) {
          // No reader means no way to confirm the redaction held, and an
          // unverifiable image is an unsendable one.
          throw new Error('re-OCR unavailable; redaction cannot be verified.');
        }
        return [await engine.recognise({ x: 0, y: 0, width: canvas.width, height: canvas.height })];
      },
      makeCanvas: canvasOf,
      encode,
    });
    timer.mark('verify');

    const { faces, ...rest } = evidence;
    const packet: VisualEvidencePacket = {
      rawDataUrl: req.dataUrl,
      redactedDataUrl: evidence.screenshotB64,
      withheld: evidence.withheld,
      masks: evidence.maskedRegions,
      width: bitmap.width,
      height: bitmap.height,
      sentBody: '',           // filled by the worker, which owns the body
      timings: timer.read(),
      sizes: { rawScreenshotBytes: dataUrlByteLength(req.dataUrl), sentBytes: 0 },
      canaries: req.canaries,
      reOcrVerified: evidence.reOcrVerified,
      provider: evidence.provider,
    };
    publishToPanels(packet);

    return {
      evidence: { ...rest, faceCount: faces.length },
      warmupMs: warmupMs ?? 0,
      timings: packet.timings,
      rawScreenshotBytes: packet.sizes.rawScreenshotBytes,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      evidence: {
        screenshotB64: null,
        withheld: `visual pass failed: ${reason}`,
        maskedRegions: [],
        ocrRegionCount: 0,
        ocrTruncated: false,
        reOcrVerified: false,
        faceCount: 0,
      },
      warmupMs: warmupMs ?? 0,
      timings: timer.read(),
      rawScreenshotBytes: dataUrlByteLength(req.dataUrl),
    };
  } finally {
    // Drop the pixels as soon as the pass is done, whatever happened.
    bitmap?.close?.();
  }
}

/** Lets the worker top up the panel packet with what only it knows. */
export function publishBodyToPanels(sentBody: string, sentBytes: number): void {
  for (const port of panels) {
    try { port.postMessage({ type: 'EVIDENCE_BODY', sentBody, sentBytes }); } catch {
      panels.delete(port);
    }
  }
}

// Warm on load so the first observation does not pay the model cost.
void ensureWarm();

chrome.runtime.onMessage.addListener((msg: { type?: string; target?: string; request?: ObserveRequest },
                                      _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;

  if (msg.type === 'OBSERVE') {
    observe(msg.request as ObserveRequest).then(sendResponse);
    return true;
  }
  if (msg.type === 'VISION_STATUS') {
    ensureWarm().then(() => sendResponse({ ...visionStatus(), warmupMs }));
    return true;
  }
  if (msg.type === 'EVIDENCE_BODY') {
    const { sentBody, sentBytes } = msg as unknown as { sentBody: string; sentBytes: number };
    publishBodyToPanels(sentBody, sentBytes);
    sendResponse({ ok: true });
  }
});

export { observe, ensureWarm };
