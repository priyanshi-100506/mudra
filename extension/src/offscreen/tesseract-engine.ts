/**
 * Tesseract, wired to read crops of the capture and nothing else.
 *
 * Every asset — the worker script, the WASM core, and the eng/hin language
 * data — is resolved from inside the extension. Tesseract.js will happily
 * fetch language data from a CDN by default, and leaving that default in
 * place would mean the first scanned Aadhaar card the agent saw caused a
 * network request the moment it was seen. That is the precise opposite of
 * what this project claims.
 */
import type { ImageRect } from '../shared/geometry';
import { OCR_LANGS, type OcrEngine } from './ocr';

function runtimeUrl(path: string): string {
  const cr = (globalThis as { chrome?: { runtime?: { getURL?(p: string): string } } }).chrome;
  return cr?.runtime?.getURL ? cr.runtime.getURL(path) : path;
}

type Worker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;

let worker: Worker | null = null;

export function resetOcr(): void {
  worker = null;
}

/**
 * Starts the OCR worker, or returns null if it cannot start.
 *
 * Null is a legitimate outcome, not an error to bubble: `ocrRegions` treats a
 * missing engine by masking every image region whole, which is the safe
 * reading of "we do not know what is in these pixels".
 */
export async function initOcr(): Promise<{ ready: boolean; reason?: string }> {
  if (worker) return { ready: true };
  try {
    const { createWorker } = await import('tesseract.js');
    worker = await createWorker(OCR_LANGS, 1, {
      workerPath: runtimeUrl('wasm/tesseract/worker.min.js'),
      corePath: runtimeUrl('wasm/tesseract/'),
      langPath: runtimeUrl('tessdata/'),
      // Language data is on disk; never reach for the network. `gzip: false`
      // matters: with it on, tesseract.js appends `.gz` to the filename and
      // the load fails, which under the fail-closed rule would mask every
      // image region whole — a silent, confusing demo failure.
      cacheMethod: 'none',
      gzip: false,
    });
    return { ready: true };
  } catch (err) {
    worker = null;
    return { ready: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Builds an engine that crops `bitmap` to each rect and reads it.
 *
 * Cropping rather than passing the whole image is the entire performance
 * argument: the regions are typically a few percent of a 1080p capture.
 */
export function tesseractEngine(bitmap: ImageBitmap): OcrEngine | null {
  if (!worker) return null;
  const w = worker;
  return {
    async recognise(rect: ImageRect): Promise<string> {
      const canvas = new OffscreenCanvas(rect.width, rect.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OCR: no 2D context for the crop.');
      ctx.drawImage(
        bitmap,
        rect.x, rect.y, rect.width, rect.height,
        0, 0, rect.width, rect.height,
      );
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const { data } = await w.recognize(blob);
      return data.text ?? '';
    },
  };
}
