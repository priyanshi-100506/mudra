/**
 * The visual half of an observation, from raw capture to a decision about
 * whether any image may be sent at all.
 *
 * One rule governs every branch below: if any stage fails — the model is
 * missing, the canvas will not allocate, OCR times out, verification does not
 * pass — the result carries `screenshotB64: null`. There is no path from a
 * failure to sending the original pixels. That is why the failure reason is
 * returned as data rather than thrown: a thrown error invites a catch block
 * somewhere upstream that "recovers" by sending what it has.
 */
import type { ImageRect } from '../shared/geometry';
import { initVision, detectFaces, type FaceRect, type VisionStatus } from './vision';

export interface VisualEvidence {
  /** The redacted image, base64, or null when nothing may be sent. */
  screenshotB64: string | null;
  /** Why no image is being sent. Present exactly when screenshotB64 is null. */
  withheld?: string;
  faces: FaceRect[];
  maskedRegions: ImageRect[];
  reOcrVerified: boolean;
  provider?: VisionStatus['provider'];
}

/** The evidence produced when the pipeline declines to send pixels. */
export function withhold(reason: string, partial: Partial<VisualEvidence> = {}): VisualEvidence {
  return {
    faces: [],
    maskedRegions: [],
    ...partial,
    screenshotB64: null,
    withheld: reason,
    reOcrVerified: false,
  };
}

/**
 * Runs detection over a capture.
 *
 * Phases 3 and 4 extend this with OCR, masking and re-OCR verification. Until
 * verification exists there is nothing that could certify an image as clean,
 * so this stage never returns one.
 */
export async function analyseCapture(bitmap: ImageBitmap): Promise<VisualEvidence> {
  const status = await initVision();
  if (!status.ready) {
    return withhold(`face detector unavailable: ${status.reason ?? 'unknown'}`);
  }
  let faces: FaceRect[];
  try {
    faces = await detectFaces(bitmap);
  } catch (err) {
    return withhold(err instanceof Error ? err.message : String(err), {
      provider: status.provider,
    });
  }
  return withhold('redaction not yet verified', { faces, provider: status.provider });
}
