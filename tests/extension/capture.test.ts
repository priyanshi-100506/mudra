import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cssRectToImageRect, imageRectToCssRect } from '../../extension/src/shared/geometry';
import { captureViewport, readViewportInfo } from '../../extension/src/background/capture';

function mockChrome(viewport: unknown, dataUrl = 'data:image/png;base64,AAAA') {
  const captureVisibleTab = vi.fn().mockResolvedValue(dataUrl);
  (globalThis as any).chrome = {
    tabs: {
      sendMessage: vi.fn().mockResolvedValue(viewport),
      get: vi.fn().mockResolvedValue({ id: 7, windowId: 3 }),
      captureVisibleTab,
    },
  };
  return captureVisibleTab;
}

describe('cssRectToImageRect', () => {
  it('is the identity at dpr 1', () => {
    expect(cssRectToImageRect({ x: 10, y: 20, width: 100, height: 40 }, 1))
      .toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });

  it('doubles every coordinate at dpr 2', () => {
    expect(cssRectToImageRect({ x: 10, y: 20, width: 100, height: 40 }, 2))
      .toEqual({ x: 20, y: 40, width: 200, height: 80 });
  });

  it('rounds outward at a fractional dpr so no original pixel is left showing', () => {
    // 2.5 * (x=10.2 .. 110.2) = 25.5 .. 275.5 -> floor 25, ceil 276
    const r = cssRectToImageRect({ x: 10.2, y: 20.1, width: 100, height: 40 }, 2.5);
    expect(r).toEqual({ x: 25, y: 50, width: 251, height: 101 });
    // The mask must cover at least the true extent, never less.
    expect(r.x).toBeLessThanOrEqual(10.2 * 2.5);
    expect(r.x + r.width).toBeGreaterThanOrEqual(110.2 * 2.5);
  });

  it('treats a nonsensical dpr as 1 rather than collapsing the rect', () => {
    expect(cssRectToImageRect({ x: 4, y: 4, width: 8, height: 8 }, 0))
      .toEqual({ x: 4, y: 4, width: 8, height: 8 });
  });

  it('round-trips back to CSS pixels', () => {
    const css = { x: 12, y: 24, width: 60, height: 30 };
    expect(imageRectToCssRect(cssRectToImageRect(css, 2), 2)).toEqual(css);
  });
});

describe('captureViewport', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns the capture sized in image pixels', async () => {
    mockChrome({ width: 800, height: 600, dpr: 2 });
    const cap = await captureViewport(7);
    expect(cap.dataUrl).toBe('data:image/png;base64,AAAA');
    expect(cap.width).toBe(1600);
    expect(cap.height).toBe(1200);
    expect(cap.dpr).toBe(2);
  });

  it('captures the window that owns the tab', async () => {
    const capture = mockChrome({ width: 100, height: 100, dpr: 1 });
    await captureViewport(7);
    expect(capture).toHaveBeenCalledWith(3, { format: 'png' });
  });

  it('carries a fractional dpr through untouched', async () => {
    mockChrome({ width: 1000, height: 700, dpr: 2.5 });
    const cap = await captureViewport(7);
    expect(cap).toMatchObject({ width: 2500, height: 1750, dpr: 2.5 });
  });

  it('throws rather than assuming dpr 1 when the page does not answer', async () => {
    mockChrome(undefined);
    await expect(captureViewport(7)).rejects.toThrow(/did not report a viewport/);
  });

  it('throws when the capture yields no image', async () => {
    mockChrome({ width: 10, height: 10, dpr: 1 }, '');
    await expect(captureViewport(7)).rejects.toThrow(/returned nothing/);
  });

  it('reads the viewport straight from the page', async () => {
    mockChrome({ width: 640, height: 480, dpr: 1.5 });
    await expect(readViewportInfo(7)).resolves.toEqual({ width: 640, height: 480, dpr: 1.5 });
  });
});
