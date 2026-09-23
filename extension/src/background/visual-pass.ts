/**
 * The worker's half of the seam.
 *
 * Three contexts meet here — content script, service worker, offscreen
 * document — all async, carrying the one message with pixels in it. So every
 * step below is written on the assumption that the next one may not answer:
 * the offscreen document may have been torn down by Chrome, the port may have
 * dropped, the model may still be loading.
 *
 * The rule is unchanged and applies to every one of those: a failure lands in
 * "no image sent", never in "no observation happened". A silently dropped
 * observation looks exactly like a clean page, which is the one confusion
 * this system cannot afford.
 */
import { captureViewport } from './capture';
import { ensureOffscreen } from './offscreen-manager';
import { cssRectToImageRect } from '../shared/geometry';
import type { DomSensitiveBox, MaskedRegion } from '../offscreen/pipeline';
import type { ObserveRequest, ObserveResult } from '../offscreen/offscreen';
import type { StageTimings } from '../shared/evidence';

/** Wall-clock ceiling for the whole visual pass. */
export const VISUAL_PASS_TIMEOUT_MS = 8000;

export interface VisualPassResult {
  screenshotB64: string | null;
  withheld?: string;
  faces: number;
  ocrRegions: number;
  maskedRegions: number;
  masks: MaskedRegion[];
  reOcrVerified: boolean;
  timings: StageTimings;
  warmupMs: number;
  rawScreenshotBytes: number;
}

/** The result when the visual pass could not produce a verified image. */
export function noImage(reason: string): VisualPassResult {
  return {
    screenshotB64: null,
    withheld: reason,
    faces: 0,
    ocrRegions: 0,
    maskedRegions: 0,
    masks: [],
    reOcrVerified: false,
    timings: { capture: 0, faces: 0, ocr: 0, redact: 0, verify: 0, network: 0 },
    warmupMs: 0,
    rawScreenshotBytes: 0,
  };
}

/**
 * Rejects after `ms`, so a stalled offscreen document cannot hang a task.
 *
 * Without this the failure mode is the worst available one: the agent appears
 * to be thinking, indefinitely, with no image and no explanation.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)),
  ]);
}

export interface VisualPassInput {
  tabId: number;
  /** Sensitive fields the DOM already identified, in CSS pixels. */
  domSensitiveBoxes: DomSensitiveBox[];
  /** Raw values this observation saw. Local only; never sent. */
  knownPiiValues: string[];
  canaryText?: string;
  canaries: { planted: number; escaped: number };
}

/**
 * Captures, analyses and returns a verified image — or nothing, with a reason.
 *
 * Note what this never does: it has no branch that returns `capture.dataUrl`.
 * The raw capture exists in this function only long enough to be handed to
 * the offscreen document, and there is deliberately no path from any failure
 * back to sending it.
 */
export async function runVisualPass(input: VisualPassInput): Promise<VisualPassResult> {
  let capture: Awaited<ReturnType<typeof captureViewport>>;
  try {
    capture = await captureViewport(input.tabId);
  } catch (err) {
    return noImage(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await ensureOffscreen();
  } catch (err) {
    return noImage(
      `offscreen document unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Image regions are collected in CSS pixels by the content script; the
  // screenshot is device pixels. This is the boundary, so this is where the
  // one conversion helper is applied.
  const request: ObserveRequest = {
    dataUrl: capture.dataUrl,
    dpr: capture.dpr,
    imageRegions: capture.imageRegions.map((r) => cssRectToImageRect(r.bbox, capture.dpr)),
    domSensitiveBoxes: input.domSensitiveBoxes,
    knownPiiValues: input.knownPiiValues,
    canaryText: input.canaryText,
    canaries: input.canaries,
  };

  let result: ObserveResult;
  try {
    result = await withTimeout(
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'OBSERVE', request }),
      VISUAL_PASS_TIMEOUT_MS,
      'visual pass',
    ) as ObserveResult;
  } catch (err) {
    return noImage(`visual pass failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!result?.evidence) {
    return noImage('visual pass returned nothing; no image sent.');
  }

  const e = result.evidence;
  return {
    // Belt and braces at the boundary: an image without verification is a
    // bug on the other side, and it stops here rather than being trusted.
    screenshotB64: e.reOcrVerified ? e.screenshotB64 : null,
    withheld: e.reOcrVerified ? undefined : (e.withheld ?? 'redaction was not verified'),
    faces: e.faceCount,
    ocrRegions: e.ocrRegionCount,
    maskedRegions: e.maskedRegions.length,
    masks: e.maskedRegions,
    reOcrVerified: Boolean(e.reOcrVerified && e.screenshotB64),
    timings: result.timings,
    warmupMs: result.warmupMs,
    rawScreenshotBytes: result.rawScreenshotBytes,
  };
}
