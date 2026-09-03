/**
 * @file redaction.ts
 * @project CLIO / MUDRA SIH26171
 *
 * Local Perception & Rule-Based Redaction Module
 * ------------------------------------------------
 * Ensures zero raw PII values ever leave the client by transforming
 * sensitive DOM values into opaque, request-scoped references before
 * the PageIR payload is serialised for the server.
 *
 * Security invariant: the forward mapping (reference → plaintext) is
 * held in an isolated in-memory Map that is never exported and never
 * appears in any serialised structure sent over the wire.
 */

import type { PageIR, PageElement } from '../shared/types';

// ---------------------------------------------------------------------------
// Internal secret store — never exported
// ---------------------------------------------------------------------------

/**
 * The canonical secret store for this module.  Key = opaque ref token,
 * Value = original plaintext PII.  Intentionally not exported so it
 * cannot appear in any network payload or log line.
 */
const _secretStore = new Map<string, string>();

/**
 * Per-session deduplication index.  Key = plaintext PII, Value = opaque ref.
 * Guarantees that the same plaintext always maps to the same ref within a
 * single page observation, which is useful for the agent to correlate fields.
 */
const _plaintextToRef = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generates a cryptographically random opaque reference token. */
function generateRef(): string {
  const bytes = new Uint8Array(4);
  // In the extension content-script context `crypto` is always available.
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `ref_${hex}`;
}

/**
 * Returns a stable opaque ref for the given plaintext value, creating one
 * if none exists.  Stores the forward mapping in _secretStore.
 */
function internPII(plaintext: string): string {
  const existing = _plaintextToRef.get(plaintext);
  if (existing !== undefined) return existing;

  const ref = generateRef();
  _plaintextToRef.set(plaintext, ref);
  _secretStore.set(ref, plaintext);
  return ref;
}

/**
 * Resets both internal stores.  Called at the start of every `redactPageIR`
 * invocation to ensure request-scoped isolation.
 */
function resetStores(): void {
  _secretStore.clear();
  _plaintextToRef.clear();
}

// ---------------------------------------------------------------------------
// Layer 1 — Verhoeff Algorithm (Aadhaar / 12-digit IDs)
// ---------------------------------------------------------------------------

/* Multiplication table d */
const _verhoeffD: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

/* Permutation table p */
const _verhoeffP: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * Validates a numeric string using the Verhoeff algorithm.
 * Returns true when the check digit is valid.
 */
export function isValidVerhoeff(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const arr = digits.split('').map(Number).reverse();
  for (let i = 0; i < arr.length; i++) {
    c = _verhoeffD[c][_verhoeffP[i % 8][arr[i]]];
  }
  return c === 0;
}

/**
 * Returns true when `s` structurally matches an Aadhaar number:
 *  — exactly 12 digits (spaces are stripped)
 *  — must not start with 0 or 1
 *  — passes Verhoeff check-digit validation
 */
export function isAadhaar(s: string): boolean {
  const digits = s.replace(/\s+/g, '');
  if (!/^\d{12}$/.test(digits)) return false;
  if (/^[01]/.test(digits)) return false;
  return isValidVerhoeff(digits);
}

// ---------------------------------------------------------------------------
// Layer 1 — Luhn Algorithm (Credit / Debit Cards)
// ---------------------------------------------------------------------------

/**
 * Validates a numeric string using the Luhn algorithm.
 * Strips spaces and dashes before evaluation.
 */
export function isValidLuhn(s: string): boolean {
  const digits = s.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Layer 1 — Regex Pattern Library
// ---------------------------------------------------------------------------

/** Compiled PII detection patterns. Each entry has a label and a RegExp. */
interface PIIPattern {
  label: string;
  /** Full-string pattern — used during token-level matching */
  fullPattern: RegExp;
  /** Search pattern — used to find candidates inside longer strings */
  searchPattern: RegExp;
  /** Optional structural validator called after regex match */
  validator?: (s: string) => boolean;
}

const PII_PATTERNS: PIIPattern[] = [
  // Aadhaar — 12 digits (with optional spaces every 4)
  {
    label: 'AADHAAR',
    fullPattern: /^\d{4}\s?\d{4}\s?\d{4}$/,
    searchPattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
    validator: (s) => isAadhaar(s),
  },
  // Credit / Debit card — 13-19 digits, optional spaces/dashes
  {
    label: 'CARD',
    fullPattern: /^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}$/,
    searchPattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,7}\b/g,
    validator: (s) => isValidLuhn(s),
  },
  // PAN — [A-Z]{5}[0-9]{4}[A-Z]
  {
    label: 'PAN',
    fullPattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
    searchPattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
  },
  // IFSC — [A-Z]{4}0[A-Z0-9]{6}
  {
    label: 'IFSC',
    fullPattern: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    searchPattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
  },
  // UPI VPA — localpart@provider
  {
    label: 'UPI_VPA',
    fullPattern: /^[\w.\-]+@[\w.\-]+$/,
    searchPattern: /\b[\w.\-]+@[\w.\-]+\b/g,
  },
  // Email — RFC-5321 simplified
  {
    label: 'EMAIL',
    fullPattern: /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/,
    searchPattern: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
  },
  // Indian Passport — [A-Z][1-9][0-9]{7}
  {
    label: 'PASSPORT_IN',
    fullPattern: /^[A-Z][1-9][0-9]{7}$/,
    searchPattern: /\b[A-Z][1-9][0-9]{7}\b/g,
  },
];

// ---------------------------------------------------------------------------
// Core PII detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `value` (taken as a complete token) matches any
 * registered PII pattern, including optional structural validators.
 */
export function isPII(value: string): boolean {
  const trimmed = value.trim();
  for (const p of PII_PATTERNS) {
    if (p.fullPattern.test(trimmed)) {
      if (p.validator && !p.validator(trimmed)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Scans `text` for embedded PII sub-strings and replaces each occurrence
 * with its assigned opaque reference.  The referenceMap is populated
 * in-place.  Returns the sanitised string.
 */
function redactString(
  text: string,
  referenceMap: Record<string, string>,
): string {
  let result = text;

  for (const p of PII_PATTERNS) {
    // Clone the pattern so lastIndex resets for each call
    const re = new RegExp(p.searchPattern.source, p.searchPattern.flags);
    result = result.replace(re, (match) => {
      const trimmed = match.trim();
      if (p.validator && !p.validator(trimmed)) return match;
      const ref = internPII(trimmed);
      referenceMap[ref] = trimmed; // exposed in returned map (plaintext only for caller)
      return ref;
    });
  }

  return result;
}

/**
 * Sanitises a nullable string field.  Returns the redacted version and
 * populates referenceMap.
 */
function redactField(
  value: string | null | undefined,
  referenceMap: Record<string, string>,
): string | null | undefined {
  if (value == null) return value;
  return redactString(value, referenceMap);
}

// ---------------------------------------------------------------------------
// Public API — PageIR redaction
// ---------------------------------------------------------------------------

/**
 * Redacts all PII from a PageIR object and returns:
 *   - `sanitizedIR` — a deep-cloned PageIR with all PII values replaced
 *     by opaque references (e.g., `ref_a8c9ef12`).
 *   - `referenceMap` — a Record mapping each reference token to its
 *     original plaintext value.  This map is only for the *caller's*
 *     use; it is **not** sent over the network and must be treated as
 *     secret by the caller.
 *
 * The internal `_secretStore` is reset at the start of every invocation
 * to enforce request-scoped isolation.
 */
export function redactPageIR(ir: PageIR): {
  sanitizedIR: PageIR;
  referenceMap: Record<string, string>;
} {
  resetStores();

  const referenceMap: Record<string, string> = {};

  // Deep-clone elements and redact sensitive fields
  const sanitizedElements: PageElement[] = ir.elements.map((el) => {
    const sanitized: PageElement = {
      ...el,
      name: redactField(el.name, referenceMap) ?? el.name,
    };

    if (el.value != null) {
      sanitized.value = redactField(el.value, referenceMap);
    }

    if (el.selected_options != null) {
      sanitized.selected_options = el.selected_options.map((opt) =>
        redactString(opt, referenceMap),
      );
    }

    return sanitized;
  });

  // Redact text snippets
  const sanitizedSnippets = ir.text_snippets.map((s) =>
    redactString(s, referenceMap),
  );

  // URL and title are structural — redact embedded PII defensively
  const sanitizedIR: PageIR = {
    url: redactString(ir.url, referenceMap),
    title: redactString(ir.title, referenceMap),
    elements: sanitizedElements,
    text_snippets: sanitizedSnippets,
    observed_at: ir.observed_at,
  };

  return { sanitizedIR, referenceMap };
}

// ---------------------------------------------------------------------------
// Canvas Screenshot Redaction (Pixel Pipeline)
// ---------------------------------------------------------------------------

/**
 * Pixel-level redaction of a canvas screenshot.
 *
 * 1. Copies all pixels from `canvas` to a fresh `<canvas>` element.
 * 2. Draws solid black filled rectangles (with 4 px padding margin) over
 *    each `DOMRect` in `elementsToMask`.
 * 3. Returns the new canvas, which can be serialised via `toDataURL` or
 *    `toBlob` as PNG/JPEG — this strips all EXIF / image metadata because
 *    the pixel data is re-encoded from scratch rather than reusing the
 *    original compressed stream.
 *
 * @param canvas         The source canvas to copy from.
 * @param elementsToMask Bounding rectangles of regions to black-out.
 * @returns              A new HTMLCanvasElement with PII regions masked.
 */
export function redactCanvas(
  canvas: HTMLCanvasElement,
  elementsToMask: DOMRect[],
): HTMLCanvasElement {
  const PADDING = 4; // px — added around each masked region

  // 1. Create a fresh output canvas with identical dimensions
  const output = document.createElement('canvas');
  output.width = canvas.width;
  output.height = canvas.height;

  const ctx = output.getContext('2d');
  if (!ctx) {
    throw new Error('redactCanvas: could not obtain 2D rendering context');
  }

  // 2. Copy source pixels onto the output canvas
  ctx.drawImage(canvas, 0, 0);

  // 3. Overlay black fill rectangles for each masked region
  ctx.fillStyle = '#000000';
  for (const rect of elementsToMask) {
    const x = Math.max(0, rect.x - PADDING);
    const y = Math.max(0, rect.y - PADDING);
    const w = Math.min(canvas.width - x, rect.width + PADDING * 2);
    const h = Math.min(canvas.height - y, rect.height + PADDING * 2);
    ctx.fillRect(x, y, w, h);
  }

  // Output is already EXIF-free: the pixel pipeline re-encodes from raw
  // ImageData — no embedded camera/GPS/IPTC metadata survives.
  return output;
}
