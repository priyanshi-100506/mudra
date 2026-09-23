import type { BoundingBox } from './types';

/**
 * A rectangle in *image* (device) pixels — the coordinate space of a
 * `chrome.tabs.captureVisibleTab` screenshot.
 *
 * It is deliberately a distinct type from `BoundingBox`, which this codebase
 * uses for CSS pixels. Mixing the two silently offsets every mask by a factor
 * of the device pixel ratio, which on a retina display means redaction boxes
 * land on the top-left quarter of the image and the PII stays visible. The
 * type split makes that mistake fail to compile.
 */
export interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Converts a CSS-pixel rect (what `getBoundingClientRect` and `PageIR.bbox`
 * give us) into image pixels.
 *
 * This is the only place `* dpr` is allowed to appear. Every coordinate that
 * crosses the DOM/screenshot boundary goes through here.
 *
 * Fractional ratios are real — 2.5 on some Android and Windows scaling, 1.5 on
 * many Linux setups — so the result is rounded outward: the origin floors and
 * the far edge ceils. Rounding a mask inward would leave a one-pixel seam of
 * the original glyphs showing along the edge, which OCR can still read.
 */
export function cssRectToImageRect(rect: BoundingBox, dpr: number): ImageRect {
  const scale = dpr > 0 ? dpr : 1;
  const x = Math.floor(rect.x * scale);
  const y = Math.floor(rect.y * scale);
  return {
    x,
    y,
    width: Math.ceil((rect.x + rect.width) * scale) - x,
    height: Math.ceil((rect.y + rect.height) * scale) - y,
  };
}

/** The inverse, for drawing image-space detections back over the live page. */
export function imageRectToCssRect(rect: ImageRect, dpr: number): BoundingBox {
  const scale = dpr > 0 ? dpr : 1;
  return {
    x: rect.x / scale,
    y: rect.y / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  };
}
