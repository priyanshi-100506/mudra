/**
 * OCR over image regions only.
 *
 * Two rules shape this module.
 *
 * First, it reads only the regions the DOM cannot explain. Running Tesseract
 * over a full screenshot takes seconds and re-derives, worse, text the PageIR
 * already has exactly.
 *
 * Second, and more important: a region that was *not* read is treated exactly
 * like a region full of PII. Budgets exist here — eight regions, 1500 ms —
 * because unbounded OCR would make the agent unusable. But a budget that
 * silently skips a region turns a performance limit into a disclosure, and a
 * scanned Aadhaar card that arrived as region nine would be sent in the
 * clear. So anything unread is masked whole.
 */
import type { ImageRect } from '../shared/geometry';
import { isPII, piiKind, type PiiLabel } from '../content/redaction';

/** At most this many regions are read per observation. */
export const MAX_OCR_REGIONS = 8;
/** Total wall-clock budget for all OCR in one observation. */
export const OCR_BUDGET_MS = 1500;

/**
 * Languages. Hindi is not a nice-to-have: Aadhaar and PAN cards, and most
 * state and central government portals, carry Devanagari, and an English-only
 * reader would miss the labels that identify a document as an ID card at all.
 */
export const OCR_LANGS = 'eng+hin';

export type OcrKind = 'aadhaar' | 'pan' | 'card' | 'phone' | 'email' | 'other';

export interface OcrRegion {
  rect: ImageRect;
  text: string;
  isPII: boolean;
  kind: OcrKind;
}

export interface OcrOutcome {
  regions: OcrRegion[];
  /**
   * True when the budget cut the pass short. Every region in
   * `unreadRegions` must then be masked entirely.
   */
  ocrTruncated: boolean;
  /** Regions that were never read, for whatever reason. Mask all of them. */
  unreadRegions: ImageRect[];
  /** Present when OCR could not run at all. */
  unavailable?: string;
}

const LABEL_TO_KIND: Record<PiiLabel, OcrKind> = {
  AADHAAR: 'aadhaar',
  PAN: 'pan',
  CARD: 'card',
  EMAIL: 'email',
  UPI_VPA: 'other',
  IFSC: 'other',
  PASSPORT_IN: 'other',
};

/** An Indian mobile number, which the shared PII table does not cover. */
const PHONE = /^(?:\+?91[\s-]?)?[6-9]\d{9}$/;

/**
 * Classifies one OCR'd string.
 *
 * The decision of *whether* something is PII is delegated entirely to
 * `isPII`, the same validator-backed detector the DOM path uses. That is what
 * lets a 12-digit order number that fails its Verhoeff check pass through
 * unflagged, which a regex-only reader cannot do.
 */
export function classifyOcrText(text: string): { isPII: boolean; kind: OcrKind } {
  const trimmed = text.trim();
  const label = piiKind(trimmed);
  if (label) return { isPII: true, kind: LABEL_TO_KIND[label] };
  if (PHONE.test(trimmed.replace(/[\s-]/g, ''))) return { isPII: true, kind: 'phone' };
  return { isPII: isPII(trimmed), kind: 'other' };
}

/**
 * Splits an OCR'd block into candidate tokens.
 *
 * Tesseract returns Aadhaar numbers as "1234 5678 9012" across one line and
 * PAN codes inside a longer caption, so both whole lines and whitespace-run
 * groupings are offered to the classifier. Checking only single words would
 * miss every space-grouped number on an Indian ID card.
 */
export function candidateTokens(block: string): string[] {
  const out = new Set<string>();
  for (const line of block.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.add(trimmed);
    const words = trimmed.split(/\s+/);
    for (const w of words) out.add(w);
    // Runs of 2 and 3 words, which is how grouped ID numbers arrive.
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        out.add(words.slice(i, i + n).join(' '));
      }
    }
  }
  return [...out];
}

/** The OCR engine, narrowed to what this module needs. */
export interface OcrEngine {
  recognise(rect: ImageRect): Promise<string>;
}

/** A clock, injected so the budget can be tested without waiting 1500 ms. */
export type Clock = () => number;

/**
 * Reads `regions`, within budget, and reports what it could not read.
 *
 * Note what happens on *every* abnormal path — budget exhausted, region
 * limit hit, engine missing, a single region throwing: the region lands in
 * `unreadRegions`. The caller masks those whole. There is no path where a
 * region is quietly dropped.
 */
export async function ocrRegions(
  engine: OcrEngine | null,
  regions: ImageRect[],
  opts: { now?: Clock; maxRegions?: number; budgetMs?: number } = {},
): Promise<OcrOutcome> {
  const now = opts.now ?? (() => Date.now());
  const maxRegions = opts.maxRegions ?? MAX_OCR_REGIONS;
  const budgetMs = opts.budgetMs ?? OCR_BUDGET_MS;

  if (!engine) {
    // No reader means no knowledge of what is in any of these pixels.
    return {
      regions: [],
      ocrTruncated: regions.length > 0,
      unreadRegions: [...regions],
      unavailable: 'OCR engine unavailable; every image region masked whole.',
    };
  }

  const started = now();
  const out: OcrRegion[] = [];
  const unread: ImageRect[] = [];
  let truncated = false;

  for (let i = 0; i < regions.length; i++) {
    const rect = regions[i];
    if (i >= maxRegions || now() - started >= budgetMs) {
      truncated = true;
      unread.push(rect);
      continue;
    }
    let text: string;
    try {
      text = await engine.recognise(rect);
    } catch {
      // A region we failed to read is a region we know nothing about.
      unread.push(rect);
      truncated = true;
      continue;
    }
    for (const token of candidateTokens(text)) {
      const { isPII: pii, kind } = classifyOcrText(token);
      if (pii) out.push({ rect, text: token, isPII: true, kind });
    }
    if (!out.some((r) => r.rect === rect)) {
      out.push({ rect, text: text.trim(), isPII: false, kind: 'other' });
    }
  }

  return { regions: out, ocrTruncated: truncated, unreadRegions: unread };
}

/**
 * The rectangles this pass requires be masked.
 *
 * Both categories are here for the same reason: they are regions whose
 * contents we cannot vouch for. One because we read PII in it, one because we
 * did not read it at all.
 */
export function rectsToMask(outcome: OcrOutcome): ImageRect[] {
  return [
    ...outcome.regions.filter((r) => r.isPII).map((r) => r.rect),
    ...outcome.unreadRegions,
  ];
}
