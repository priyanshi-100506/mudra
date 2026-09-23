/**
 * Screenshot capture.
 *
 * Everything this module returns is raw, unredacted pixels. It is the one
 * point in MUDRA that holds an image of the user's screen, and the rule that
 * governs it is absolute: the `dataUrl` below is passed in memory to the
 * offscreen document for redaction and then dropped. It is never written to
 * `chrome.storage`, never logged, and never placed in a network payload.
 */

import type { ImageRegion } from '../content/image-regions';

/** What the content script reports about the page's own coordinate space. */
export interface ViewportInfo {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Multiply CSS px by this to reach screenshot px. */
  dpr: number;
  /** Image-like regions, in CSS pixels, for the OCR pass to narrow to. */
  imageRegions: ImageRegion[];
}

export interface Capture extends ViewportInfo {
  /** In-memory only. NEVER persisted or sent. */
  dataUrl: string;
}

/** Asks the page for its own device pixel ratio and viewport size. */
export async function readViewportInfo(tabId: number): Promise<ViewportInfo> {
  const info = (await chrome.tabs.sendMessage(tabId, {
    type: 'GET_VIEWPORT_INFO',
  })) as Partial<ViewportInfo> | undefined;
  if (!info || typeof info.dpr !== 'number') {
    throw new Error('captureViewport: the page did not report a viewport.');
  }
  return {
    width: info.width ?? 0,
    height: info.height ?? 0,
    dpr: info.dpr,
    imageRegions: info.imageRegions ?? [],
  };
}

/**
 * Captures the visible area of `tabId`.
 *
 * The returned width/height are in *image* pixels, so that callers can size a
 * canvas without decoding the PNG first — a service worker has no `Image`.
 * They are derived from the page's own CSS viewport times its DPR rather than
 * guessed, which keeps the mask coordinates and the bitmap in one space.
 */
export async function captureViewport(tabId: number): Promise<Capture> {
  const { width, height, dpr, imageRegions } = await readViewportInfo(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId === undefined) {
    throw new Error('captureViewport: the tab has no window.');
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  if (!dataUrl) {
    throw new Error('captureViewport: the capture returned nothing.');
  }
  return {
    dataUrl,
    width: Math.round(width * dpr),
    height: Math.round(height * dpr),
    dpr,
    imageRegions,
  };
}
