/**
 * On-device face detection.
 *
 * This runs in the offscreen document rather than the service worker because
 * MV3 workers have no DOM, and both ONNX Runtime's WASM backend and the
 * canvas work below need one. The raw screenshot reaches this module and is
 * discarded here; nothing in this file writes to storage or to the network.
 *
 * The model is UltraFace-320 (version-RFB-320.onnx), a ~1.2 MB detector that
 * runs comfortably in WASM. Its provenance and hash are recorded in
 * public/models/README.md.
 */
import type { ImageRect } from '../shared/geometry';

/** Detector input geometry, fixed by the exported graph. */
export const MODEL_WIDTH = 320;
export const MODEL_HEIGHT = 240;
const MODEL_PATH = 'models/version-RFB-320.onnx';

/** Confidence below which a candidate box is discarded. */
export const SCORE_THRESHOLD = 0.7;
/** Two boxes overlapping more than this are treated as one face. */
export const NMS_IOU_THRESHOLD = 0.3;
/**
 * Each surviving box grows by this fraction on every side.
 *
 * UltraFace boxes hug the facial landmarks, so an unpadded mask leaves hair,
 * chin and ear edges visible. Those are identifying, and on a low-resolution
 * capture they are most of what a person is recognisable by.
 */
export const BOX_PADDING = 0.1;

export interface FaceRect extends ImageRect {
  /** Detector confidence, carried through for the telemetry panel. */
  score: number;
}

export interface VisionStatus {
  /**
   * False means the pipeline must send no image at all. There is no degraded
   * mode: an undetected face is an unmasked face, so a detector that did not
   * load is a reason to withhold the capture, never a reason to send it raw.
   */
  ready: boolean;
  reason?: string;
  /** Which execution provider actually answered. */
  provider?: 'webgpu' | 'wasm';
}

// ---------------------------------------------------------------------------
// Pure geometry and post-processing. Kept free of ORT and of the DOM so the
// parts most likely to be wrong are also the parts easiest to test.
// ---------------------------------------------------------------------------

/** Intersection over union of two image-space rectangles. */
export function iou(a: ImageRect, b: ImageRect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (overlap <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - overlap;
  return union > 0 ? overlap / union : 0;
}

/**
 * Non-maximum suppression: keeps the highest-scoring box in each cluster of
 * overlapping candidates.
 *
 * UltraFace emits thousands of anchor boxes and a single face typically
 * survives thresholding as a dozen near-identical ones. Without this the
 * redactor would paint the same region repeatedly, and the reported face
 * count — which is a number we put in front of a user — would be nonsense.
 */
export function nms(boxes: FaceRect[], threshold = NMS_IOU_THRESHOLD): FaceRect[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: FaceRect[] = [];
  for (const candidate of sorted) {
    if (kept.every((k) => iou(k, candidate) <= threshold)) kept.push(candidate);
  }
  return kept;
}

/**
 * Grows a box by `fraction` on every side, clamped to the image.
 *
 * Clamping matters: a face at the edge of the viewport produces a padded box
 * with a negative origin, and a negative-origin fillRect silently draws
 * nothing in some canvas implementations rather than clipping.
 */
export function padRect<T extends ImageRect>(
  rect: T,
  fraction: number,
  imageWidth: number,
  imageHeight: number,
): T {
  const dx = rect.width * fraction;
  const dy = rect.height * fraction;
  const x = Math.max(0, Math.round(rect.x - dx));
  const y = Math.max(0, Math.round(rect.y - dy));
  return {
    ...rect,
    x,
    y,
    width: Math.min(imageWidth - x, Math.round(rect.width + dx * 2)),
    height: Math.min(imageHeight - y, Math.round(rect.height + dy * 2)),
  };
}

/**
 * Turns RGBA bytes from a 320x240 canvas into the NCHW float tensor the graph
 * expects: channel-planar, mean 127, scale 1/128.
 */
export function normaliseToTensor(
  rgba: Uint8ClampedArray,
  width = MODEL_WIDTH,
  height = MODEL_HEIGHT,
): Float32Array {
  const pixels = width * height;
  const out = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    // NCHW: all of R, then all of G, then all of B — not interleaved.
    out[i] = (rgba[i * 4] - 127) / 128;
    out[pixels + i] = (rgba[i * 4 + 1] - 127) / 128;
    out[pixels * 2 + i] = (rgba[i * 4 + 2] - 127) / 128;
  }
  return out;
}

/**
 * Decodes the model's two output tensors into image-space rectangles.
 *
 * `scores` is [1, N, 2] as (background, face) and `boxes` is [1, N, 4] as
 * (x1, y1, x2, y2) normalised to 0..1 — so every coordinate is scaled by the
 * *original* image size, not the 320x240 the model saw.
 */
export function decodeDetections(
  scores: ArrayLike<number>,
  boxes: ArrayLike<number>,
  imageWidth: number,
  imageHeight: number,
  threshold = SCORE_THRESHOLD,
): FaceRect[] {
  const out: FaceRect[] = [];
  const count = Math.floor(scores.length / 2);
  for (let i = 0; i < count; i++) {
    const score = scores[i * 2 + 1];
    if (score < threshold) continue;
    const x1 = boxes[i * 4] * imageWidth;
    const y1 = boxes[i * 4 + 1] * imageHeight;
    const x2 = boxes[i * 4 + 2] * imageWidth;
    const y2 = boxes[i * 4 + 3] * imageHeight;
    const x = Math.max(0, Math.round(Math.min(x1, x2)));
    const y = Math.max(0, Math.round(Math.min(y1, y2)));
    const width = Math.min(imageWidth - x, Math.round(Math.abs(x2 - x1)));
    const height = Math.min(imageHeight - y, Math.round(Math.abs(y2 - y1)));
    if (width <= 0 || height <= 0) continue;
    out.push({ x, y, width, height, score });
  }
  return out;
}

/** The full post-processing chain, so callers cannot apply it out of order. */
export function postprocess(
  scores: ArrayLike<number>,
  boxes: ArrayLike<number>,
  imageWidth: number,
  imageHeight: number,
): FaceRect[] {
  const decoded = decodeDetections(scores, boxes, imageWidth, imageHeight);
  return nms(decoded).map((r) => padRect(r, BOX_PADDING, imageWidth, imageHeight));
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

type OrtModule = typeof import('onnxruntime-web');

let session: import('onnxruntime-web').InferenceSession | null = null;
let ort: OrtModule | null = null;
let status: VisionStatus = { ready: false, reason: 'not initialised' };

/** Exposed for tests; forgets any loaded session. */
export function resetVision(): void {
  session = null;
  ort = null;
  status = { ready: false, reason: 'not initialised' };
}

export function visionStatus(): VisionStatus {
  return status;
}

/** Resolves an extension-relative path, or falls back for test environments. */
function runtimeUrl(path: string): string {
  const cr = (globalThis as { chrome?: { runtime?: { getURL?(p: string): string } } }).chrome;
  return cr?.runtime?.getURL ? cr.runtime.getURL(path) : path;
}

/**
 * Loads the detector once.
 *
 * Every failure path here returns `{ ready: false }` with a reason rather than
 * throwing, because the caller's correct response to any of them is identical
 * and non-negotiable: send no image.
 */
export async function initVision(): Promise<VisionStatus> {
  if (status.ready && session) return status;
  try {
    ort = await import('onnxruntime-web');
    // Local only. A CDN fetch here would quietly undo the offline claim, and
    // on a locked-down network it would fail at demo time.
    ort.env.wasm.wasmPaths = runtimeUrl('wasm/');

    const preferWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const providers = preferWebGpu ? ['webgpu', 'wasm'] : ['wasm'];

    session = await ort.InferenceSession.create(runtimeUrl(MODEL_PATH), {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    });

    status = { ready: true, provider: preferWebGpu ? 'webgpu' : 'wasm' };
  } catch (err) {
    session = null;
    status = {
      ready: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return status;
}

/** Draws a bitmap into the model's input size and reads back its pixels. */
function resizeToModelInput(bitmap: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(MODEL_WIDTH, MODEL_HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('detectFaces: no 2D context for preprocessing.');
  ctx.drawImage(bitmap, 0, 0, MODEL_WIDTH, MODEL_HEIGHT);
  return ctx.getImageData(0, 0, MODEL_WIDTH, MODEL_HEIGHT).data;
}

/**
 * Detects faces in a full-size capture, returning rectangles in that
 * capture's own pixel coordinates.
 *
 * Throws if the session is not ready. That is deliberate — a caller that
 * reaches here without a ready detector has a bug, and the fail-closed rule
 * means it must not be able to continue to the "send the image" branch.
 */
export async function detectFaces(bitmap: ImageBitmap): Promise<FaceRect[]> {
  if (!session || !ort) {
    throw new Error('detectFaces: the detector is not ready; send no image.');
  }
  const tensor = new ort.Tensor(
    'float32',
    normaliseToTensor(resizeToModelInput(bitmap)),
    [1, 3, MODEL_HEIGHT, MODEL_WIDTH],
  );
  const feeds: Record<string, unknown> = { [session.inputNames[0]]: tensor };
  const results = await session.run(feeds as never);

  // The graph names its outputs "scores" and "boxes"; fall back to order for
  // a re-export that renamed them.
  const names = session.outputNames;
  const scores = results[names.find((n) => /score|conf/i.test(n)) ?? names[0]];
  const boxes = results[names.find((n) => /box/i.test(n)) ?? names[1]];
  if (!scores || !boxes) {
    throw new Error('detectFaces: unexpected model outputs; send no image.');
  }
  return postprocess(
    scores.data as Float32Array,
    boxes.data as Float32Array,
    bitmap.width,
    bitmap.height,
  );
}
