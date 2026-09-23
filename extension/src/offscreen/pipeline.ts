/**
 * The visual half of an observation, from raw capture to a decision about
 * whether any image may be sent at all.
 *
 * One rule governs every branch below: if any stage fails — the model is
 * missing, the canvas will not allocate, OCR times out, verification does not
 * pass — the result carries `screenshotB64: null`. There is no path from a
 * failure to sending the original pixels. That is why failure reasons are
 * returned as data rather than thrown: a thrown error invites a catch block
 * somewhere upstream that "recovers" by sending what it has.
 */
import { cssRectToImageRect, type ImageRect } from '../shared/geometry';
import type { BoundingBox } from '../shared/types';
import { redactCanvas } from '../content/redaction';
import { initVision, detectFaces, type FaceRect, type VisionStatus } from './vision';
import { ocrRegions, rectsToMask, type OcrEngine, type OcrOutcome } from './ocr';
import { verifyRedactedText, type VerificationResult } from './verify';

/** A rectangle the pipeline decided to paint over, and why. */
export interface MaskedRegion extends ImageRect {
  /** The source that asked for the mask. */
  kind: 'FACE' | 'OCR_PII' | 'UNREAD_REGION' | 'DOM_SENSITIVE';
  /**
   * What to print on the box in the split view: FACE, AADHAAR, PASSWORD,
   * HINDI-OCR.
   *
   * Separate from `kind` because the two answer different questions. `kind`
   * is which detector fired, which is what the pipeline reasons about.
   * `label` is what a person reading a projected screenshot from the back of
   * a room needs to see, and "OCR_PII" tells them nothing.
   */
  label: string;
}

/** True when the text carries Devanagari, i.e. the Hindi reader earned it. */
function isDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/.test(text);
}

/**
 * The label for a sensitive DOM field.
 *
 * Falls back to SENSITIVE rather than to the field's own name: a name is page
 * content, and page content on a slide is how a real value ends up projected
 * while demonstrating that real values are never projected.
 */
export function domFieldLabel(inputType?: string | null, name?: string | null): string {
  if (inputType === 'password') return 'PASSWORD';
  if (inputType === 'tel') return 'PHONE';
  const n = (name ?? '').toLowerCase();
  if (/aadhaar|aadhar|\buid\b/.test(n)) return 'AADHAAR';
  if (/\bpan\b|permanent account/.test(n)) return 'PAN';
  if (/card|cvv|cvc/.test(n)) return 'CARD';
  if (/otp|passcode|\bpin\b/.test(n)) return 'OTP';
  return 'SENSITIVE';
}

export interface VisualEvidence {
  /** The redacted image, base64, or null when nothing may be sent. */
  screenshotB64: string | null;
  /** Why no image is being sent. Present exactly when screenshotB64 is null. */
  withheld?: string;
  faces: FaceRect[];
  maskedRegions: MaskedRegion[];
  ocrRegionCount: number;
  ocrTruncated: boolean;
  reOcrVerified: boolean;
  verification?: VerificationResult;
  provider?: VisionStatus['provider'];
}

/** The evidence produced when the pipeline declines to send pixels. */
export function withhold(reason: string, partial: Partial<VisualEvidence> = {}): VisualEvidence {
  return {
    faces: [],
    maskedRegions: [],
    ocrRegionCount: 0,
    ocrTruncated: false,
    ...partial,
    // These two are set last and unconditionally. A caller cannot construct a
    // withheld result that still carries pixels or claims verification.
    screenshotB64: null,
    withheld: reason,
    reOcrVerified: false,
  };
}

/**
 * Assembles every rectangle to paint over.
 *
 * Three independent sources, deliberately unioned rather than reconciled: the
 * face detector, the OCR pass (both what it read and what it could not), and
 * the DOM's own view of which fields are sensitive. They disagree often —
 * OCR reads a card number the DOM has as a masked input, the detector finds a
 * face in a photo the DOM calls a decorative image — and in every such case
 * the safe resolution is to mask.
 */
export function assembleMasks(
  faces: FaceRect[],
  ocr: OcrOutcome,
  domSensitiveBoxes: DomSensitiveBox[],
  dpr: number,
): MaskedRegion[] {
  const masks: MaskedRegion[] = [];
  for (const f of faces) {
    masks.push({ x: f.x, y: f.y, width: f.width, height: f.height, kind: 'FACE', label: 'FACE' });
  }
  for (const r of ocr.regions) {
    // Zero-area rects come from the canary stream, which has no pixels on
    // screen. Painting them would be a no-op that inflates the masked-region
    // count we show the user, and that number has to stay true.
    if (r.isPII && r.rect.width > 0 && r.rect.height > 0) {
      masks.push({
        ...r.rect,
        kind: 'OCR_PII',
        // Devanagari gets its own label because reading it is the thing no
        // competing team does, and a box marked AADHAAR does not show that
        // the Hindi reader is what found it.
        label: isDevanagari(r.text) ? 'HINDI-OCR' : r.kind.toUpperCase(),
      });
    }
  }
  for (const r of ocr.unreadRegions) {
    masks.push({ ...r, kind: 'UNREAD_REGION', label: 'NOT READ' });
  }
  // The only place DOM coordinates cross into image space.
  for (const b of domSensitiveBoxes) {
    masks.push({
      ...cssRectToImageRect(b.bbox, dpr),
      kind: 'DOM_SENSITIVE',
      label: domFieldLabel(b.inputType, b.name),
    });
  }
  return masks;
}

/** A sensitive field the DOM already told us about, in CSS pixels. */
export interface DomSensitiveBox {
  bbox: BoundingBox;
  inputType?: string | null;
  name?: string | null;
}

export interface AnalyseInput {
  bitmap: ImageBitmap;
  dpr: number;
  /** Image regions to OCR, already in image pixels. */
  imageRegions: ImageRect[];
  /** Sensitive element boxes from the PageIR, in CSS pixels. */
  domSensitiveBoxes: DomSensitiveBox[];
  /** Raw values this observation saw. Local only; never sent. */
  knownPiiValues: string[];
  /** Reads a region of the original capture. */
  ocrEngine: OcrEngine | null;
  /** Reads the whole redacted image back, for verification. */
  reOcr: (canvas: HTMLCanvasElement) => Promise<string[]>;
  /** Builds the canvas holding the raw capture. Injected so this is testable. */
  makeCanvas: (bitmap: ImageBitmap) => HTMLCanvasElement;
  /** Serialises the redacted canvas. Injected for the same reason. */
  encode: (canvas: HTMLCanvasElement) => Promise<string>;
  /** Canary tracer text, injected into the OCR stream. Never sent. */
  canaryText?: string;
}

/**
 * Detects, masks, verifies, and only then permits an image to be sent.
 *
 * The ordering is the point. Verification runs on the *output* of redaction,
 * not on the list of rectangles that went into it, because a correct-looking
 * mask list and a correctly masked image are different claims and only the
 * second one matters.
 */
export async function analyseCapture(input: AnalyseInput): Promise<VisualEvidence> {
  const status = await initVision();
  if (!status.ready) {
    return withhold(`face detector unavailable: ${status.reason ?? 'unknown'}`);
  }

  let faces: FaceRect[];
  try {
    faces = await detectFaces(input.bitmap);
  } catch (err) {
    return withhold(err instanceof Error ? err.message : String(err), {
      provider: status.provider,
    });
  }

  const ocr = await ocrRegions(input.ocrEngine, input.imageRegions, {
    canaryText: input.canaryText,
  });
  const masks = assembleMasks(faces, ocr, input.domSensitiveBoxes, input.dpr);
  const base = {
    faces,
    ocrRegionCount: ocr.regions.length,
    ocrTruncated: ocr.ocrTruncated,
    maskedRegions: masks,
    provider: status.provider,
  };

  let redacted: HTMLCanvasElement;
  let reOcrText: string[];
  try {
    redacted = redactCanvas(input.makeCanvas(input.bitmap), masks);
    reOcrText = await input.reOcr(redacted);
  } catch (err) {
    return withhold(
      `redaction or re-OCR failed: ${err instanceof Error ? err.message : String(err)}`,
      base,
    );
  }

  // Everything the observation saw in the clear, from both the DOM and the
  // first OCR pass, is what we now confirm is gone.
  const known = [
    ...input.knownPiiValues,
    ...ocr.regions.filter((r) => r.isPII).map((r) => r.text),
  ];
  const verification = verifyRedactedText(reOcrText, known);
  if (!verification.verified) {
    return withhold(verification.reason ?? 're-OCR verification failed', {
      ...base,
      verification,
    });
  }

  return {
    ...base,
    screenshotB64: await input.encode(redacted),
    reOcrVerified: true,
    verification,
  };
}

/** Also exported for tests that need the union without the full pipeline. */
export { rectsToMask };
