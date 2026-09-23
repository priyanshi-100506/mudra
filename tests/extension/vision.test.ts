import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  iou, nms, padRect, decodeDetections, postprocess, normaliseToTensor,
  initVision, detectFaces, resetVision, visionStatus,
  BOX_PADDING, SCORE_THRESHOLD, MODEL_WIDTH, MODEL_HEIGHT,
  type FaceRect,
} from '../../extension/src/offscreen/vision';
import { analyseCapture, withhold } from '../../extension/src/offscreen/pipeline';

const box = (x: number, y: number, w: number, h: number, score = 0.9): FaceRect =>
  ({ x, y, width: w, height: h, score });

describe('iou', () => {
  it('is 1 for identical boxes and 0 for disjoint ones', () => {
    expect(iou(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBe(1);
    expect(iou(box(0, 0, 10, 10), box(50, 50, 10, 10))).toBe(0);
  });

  it('is 0 for boxes that merely touch at an edge', () => {
    expect(iou(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(0);
  });
});

describe('nms', () => {
  it('collapses a cluster of overlapping boxes to the highest scoring one', () => {
    const kept = nms([
      box(100, 100, 50, 50, 0.80),
      box(104, 102, 50, 50, 0.95),
      box(98, 99, 50, 50, 0.85),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(0.95);
  });

  it('keeps genuinely separate faces', () => {
    const kept = nms([box(0, 0, 40, 40, 0.9), box(200, 200, 40, 40, 0.8)]);
    expect(kept).toHaveLength(2);
  });

  it('keeps two faces that overlap less than the threshold', () => {
    // Offset far enough that IoU falls under 0.3.
    const kept = nms([box(0, 0, 40, 40, 0.9), box(28, 0, 40, 40, 0.8)]);
    expect(kept).toHaveLength(2);
  });

  it('leaves the caller’s array untouched', () => {
    const input = [box(0, 0, 10, 10, 0.5), box(1, 1, 10, 10, 0.9)];
    nms(input);
    expect(input[0].score).toBe(0.5);
  });
});

describe('padRect', () => {
  it('grows the box by 10% on every side', () => {
    const p = padRect(box(100, 100, 50, 50), BOX_PADDING, 1000, 1000);
    expect(p).toMatchObject({ x: 95, y: 95, width: 60, height: 60 });
  });

  it('clamps at the image edge instead of producing a negative origin', () => {
    const p = padRect(box(2, 2, 50, 50), BOX_PADDING, 1000, 1000);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
  });

  it('does not run past the far edge of the image', () => {
    const p = padRect(box(950, 950, 50, 50), BOX_PADDING, 1000, 1000);
    expect(p.x + p.width).toBeLessThanOrEqual(1000);
    expect(p.y + p.height).toBeLessThanOrEqual(1000);
  });

  it('carries the score through', () => {
    expect(padRect(box(10, 10, 10, 10, 0.77), BOX_PADDING, 100, 100).score).toBe(0.77);
  });
});

describe('decodeDetections', () => {
  // Two anchors: one confident face, one background.
  const scores = [0.05, 0.95, 0.9, 0.1];
  const boxes = [0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.6, 0.6];

  it('scales normalised coordinates to the original image, not the model input', () => {
    const d = decodeDetections(scores, boxes, 1000, 500);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ x: 100, y: 100, width: 200, height: 100 });
  });

  it('drops anything below the score threshold', () => {
    expect(decodeDetections([0.7, 0.69], [0, 0, 0.5, 0.5], 100, 100)).toHaveLength(0);
    expect(decodeDetections([0.3, 0.71], [0, 0, 0.5, 0.5], 100, 100)).toHaveLength(1);
    expect(SCORE_THRESHOLD).toBe(0.7);
  });

  it('discards degenerate zero-area boxes', () => {
    expect(decodeDetections([0, 0.99], [0.5, 0.5, 0.5, 0.5], 100, 100)).toHaveLength(0);
  });
});

describe('postprocess', () => {
  it('thresholds, suppresses and pads in that order', () => {
    // Three near-identical confident anchors over one face, plus background.
    const scores = [0, 0.9, 0, 0.95, 0, 0.92, 0.99, 0.01];
    const boxes = [
      0.10, 0.10, 0.20, 0.20,
      0.11, 0.10, 0.21, 0.20,
      0.10, 0.11, 0.20, 0.21,
      0.80, 0.80, 0.90, 0.90,
    ];
    const out = postprocess(scores, boxes, 1000, 1000);
    expect(out).toHaveLength(1);
    // Raw box is 110..210; padded by 10% of its 100px width.
    expect(out[0].width).toBe(120);
    expect(out[0].x).toBe(100);
  });
});

describe('normaliseToTensor', () => {
  it('lays pixels out channel-planar with mean 127 and scale 1/128', () => {
    const rgba = new Uint8ClampedArray(2 * 1 * 4);
    rgba.set([127, 255, 0, 255], 0);
    rgba.set([0, 127, 255, 255], 4);
    const t = normaliseToTensor(rgba, 2, 1);
    expect(t).toHaveLength(6);
    expect(t[0]).toBeCloseTo(0);            // R of pixel 0
    expect(t[1]).toBeCloseTo(-127 / 128);   // R of pixel 1
    expect(t[2]).toBeCloseTo(128 / 128);    // G of pixel 0
    expect(t[4]).toBeCloseTo(-127 / 128);   // B of pixel 0
  });

  it('produces a tensor of the model input size by default', () => {
    const rgba = new Uint8ClampedArray(MODEL_WIDTH * MODEL_HEIGHT * 4);
    expect(normaliseToTensor(rgba)).toHaveLength(MODEL_WIDTH * MODEL_HEIGHT * 3);
  });
});

describe('failing closed when the model is absent', () => {
  beforeEach(() => resetVision());

  it('reports ready: false with a reason rather than throwing', async () => {
    const status = await initVision();
    expect(status.ready).toBe(false);
    expect(status.reason).toBeTruthy();
    expect(visionStatus().ready).toBe(false);
  });

  it('refuses to run inference instead of returning an empty face list', async () => {
    // An empty list would be indistinguishable from "no faces present", which
    // would let an unmasked face through as though it had been checked.
    await initVision();
    await expect(detectFaces({ width: 10, height: 10 } as ImageBitmap))
      .rejects.toThrow(/not ready|send no image/);
  });

  it('sends no image when the detector did not load', async () => {
    const evidence = await analyseCapture({ width: 800, height: 600 } as ImageBitmap);
    expect(evidence.screenshotB64).toBeNull();
    expect(evidence.withheld).toMatch(/face detector unavailable/);
    expect(evidence.reOcrVerified).toBe(false);
  });

  it('never lets a partial result carry pixels or a verified flag', () => {
    const e = withhold('anything at all', {
      screenshotB64: 'data:image/png;base64,RAW' as unknown as string,
      reOcrVerified: true,
    } as never);
    expect(e.screenshotB64).toBeNull();
    expect(e.reOcrVerified).toBe(false);
  });
});
