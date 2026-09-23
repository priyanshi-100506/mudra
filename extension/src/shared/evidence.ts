/**
 * What the "What the AI sees" panel is shown.
 *
 * This is the one structure in MUDRA that carries a raw, unredacted capture,
 * and it exists under a single hard constraint: it travels from the offscreen
 * document to the side panel over a direct runtime port, is held in a React
 * ref, and is dropped when the view unmounts. It is never written to
 * `chrome.storage`, never included in a network payload, and never logged.
 *
 * The raw pane is the honest half of the demo — it is what makes the redacted
 * half mean anything — but it is also the single largest liability in the
 * codebase, so the rule is that it lives in memory, on one machine, for as
 * long as someone is looking at it.
 */
import type { MaskedRegion } from '../offscreen/pipeline';

/** The named stages of one observation, in milliseconds. */
export interface StageTimings {
  capture: number;
  faces: number;
  ocr: number;
  redact: number;
  verify: number;
  network: number;
  /** Peak JS heap during the observation, in MB. Undefined off Chromium. */
  heapMb?: number;
}

/**
 * Bytes, measured rather than estimated.
 *
 * This ratio is the satellite and low-bandwidth argument, so it has to
 * survive being questioned. Both numbers are the real byte lengths of real
 * artefacts: the PNG that was captured, and the body that was posted.
 */
export interface PayloadSizes {
  /** Byte length of the raw capture's PNG. */
  rawScreenshotBytes: number;
  /** Byte length of the serialised request body actually sent. */
  sentBytes: number;
}

export interface VisualEvidencePacket {
  /** Raw capture, data URL. Local render only. NEVER persisted or sent. */
  rawDataUrl: string;
  /**
   * The redacted image that was sent, or null when none was.
   *
   * Null is a state the panel must render explicitly — "no image sent, and
   * here is why" — rather than as an empty pane. Failing closed is a feature,
   * and a blank box communicates nothing.
   */
  redactedDataUrl: string | null;
  /** Why no image was sent. Present exactly when redactedDataUrl is null. */
  withheld?: string;
  masks: MaskedRegion[];
  /** Image pixel dimensions, for scaling the mask overlay. */
  width: number;
  height: number;
  /** The exact body posted, as sent. Not re-serialised for display. */
  sentBody: string;
  timings: StageTimings;
  sizes: PayloadSizes;
  canaries: { planted: number; escaped: number };
  reOcrVerified: boolean;
  provider?: 'webgpu' | 'wasm';
}

/** Port name for the offscreen → panel channel. */
export const EVIDENCE_PORT = 'mudra-evidence';

/** Bytes in a data URL's payload, without allocating a copy of it. */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** Byte length of a string as UTF-8, which is what goes on the wire. */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Formats a byte count the way the demo line reads.
 *
 * Deliberately not rounded up for effect. The ratio this feeds is the
 * bandwidth argument, and a figure that flatters itself is one question away
 * from becoming the reason nobody believes the rest.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The "900x less data" line, computed from real byte counts.
 *
 * Returns null when there is nothing to compare, rather than a fabricated
 * ratio. If no image was captured there is no saving to claim, and claiming
 * one anyway is exactly the failure mode this project is arguing against.
 */
export function compressionLine(sizes: PayloadSizes): string | null {
  const { rawScreenshotBytes, sentBytes } = sizes;
  if (rawScreenshotBytes <= 0 || sentBytes <= 0) return null;
  const ratio = rawScreenshotBytes / sentBytes;
  if (ratio < 1) return null;
  const shown = ratio >= 10 ? Math.round(ratio) : Number(ratio.toFixed(1));
  return `sent ${formatBytes(sentBytes)} instead of ${formatBytes(rawScreenshotBytes)} — ${shown}x less data`;
}

/** Peak JS heap in MB, when the browser reports it. */
export function heapMb(): number | undefined {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Number((mem.usedJSHeapSize / (1024 * 1024)).toFixed(1)) : undefined;
}

/** A stopwatch for the stage waterfall. */
export function stageTimer() {
  const marks: Partial<StageTimings> = {};
  let last = performance.now();
  return {
    mark(stage: keyof StageTimings): void {
      const now = performance.now();
      (marks as Record<string, number>)[stage] = Math.round(now - last);
      last = now;
    },
    read(): StageTimings {
      return {
        capture: marks.capture ?? 0,
        faces: marks.faces ?? 0,
        ocr: marks.ocr ?? 0,
        redact: marks.redact ?? 0,
        verify: marks.verify ?? 0,
        network: marks.network ?? 0,
        heapMb: heapMb(),
      };
    },
  };
}
