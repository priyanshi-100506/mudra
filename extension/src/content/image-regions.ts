/**
 * Finds the parts of the page the DOM cannot explain.
 *
 * OCR over a whole 1080p screenshot costs seconds and buys almost nothing:
 * the PageIR already carries every piece of ordinary text on the page, with
 * far better fidelity than OCR would give. The pixels worth reading are the
 * ones where text exists but the DOM has no record of it — a scanned card in
 * an <img>, a chart or a whole application drawn into a <canvas>, a frame of
 * video, an element whose background-image is the content.
 *
 * Narrowing to those regions is what makes on-device OCR affordable at all,
 * which is the point of the problem statement.
 */
import type { BoundingBox } from '../shared/types';

/** Anything smaller than this on either side is an icon, not content. */
export const MIN_REGION_PX = 64;

export type RegionKind = 'img' | 'canvas' | 'svg' | 'video' | 'background';

export interface ImageRegion {
  /** CSS pixels, viewport-relative — the same space as PageIR bboxes. */
  bbox: BoundingBox;
  kind: RegionKind;
}

function isOnScreen(r: DOMRect, viewportWidth: number, viewportHeight: number): boolean {
  return r.bottom > 0 && r.right > 0 && r.top < viewportHeight && r.left < viewportWidth;
}

/**
 * True when the element paints a bitmap we cannot otherwise account for.
 *
 * `background-image` is included because a surprising number of Indian
 * government and banking portals render a scanned document as a styled div
 * rather than an <img>, and a region list that missed those would leave the
 * exact documents this project exists to protect unexamined.
 */
function backgroundImageUrl(el: Element): boolean {
  const bg = getComputedStyle(el).backgroundImage;
  return Boolean(bg) && bg !== 'none' && /url\(/i.test(bg);
}

/**
 * Collects the visible, content-sized image regions of the current document.
 *
 * Off-screen elements are skipped because the screenshot only contains the
 * visible tab — a region outside it has no pixels to read, and cropping to it
 * would sample whatever happens to be at those coordinates instead.
 */
export function collectImageRegions(doc: Document = document): ImageRegion[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out: ImageRegion[] = [];
  const seen = new Set<Element>();

  const push = (el: Element, kind: RegionKind) => {
    if (seen.has(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < MIN_REGION_PX || r.height < MIN_REGION_PX) return;
    if (!isOnScreen(r, vw, vh)) return;
    seen.add(el);
    // Clip to the viewport: coordinates outside it index into nothing.
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    out.push({
      kind,
      bbox: {
        x,
        y,
        width: Math.min(vw, r.right) - x,
        height: Math.min(vh, r.bottom) - y,
      },
    });
  };

  for (const el of doc.querySelectorAll('img')) push(el, 'img');
  for (const el of doc.querySelectorAll('canvas')) push(el, 'canvas');
  for (const el of doc.querySelectorAll('svg')) push(el, 'svg');
  for (const el of doc.querySelectorAll('video')) push(el, 'video');
  for (const el of doc.querySelectorAll('*')) {
    if (!seen.has(el) && backgroundImageUrl(el)) push(el, 'background');
  }

  return out;
}
