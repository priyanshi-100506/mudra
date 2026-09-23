import type { PageIR, PageElement } from './types';
import type { SceneElement, DetectionCounts, RedactionCounts, OutboundSummary, RedactedField } from './agent-events';
import { redactSnippets, isPII } from '../content/redaction';

const PAN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;
const AADHAAR = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
const CARD = /\b\d{13,19}\b/;
const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/;
const UPI = /\b[\w.\-]{2,}@[a-zA-Z]{2,}\b/;
const SENSITIVE_NAME =
  /(pass\s?word|pwd|passcode|otp|mfa|2fa|cvv|cvc|\bpin\b|security\s?code|aadhaar|aadhar|\buid\b|\bpan\b|permanent\s?account|card\s?(number|no|verification)|credit\s?card|debit\s?card|expir|account\s?(number|no)|ifsc|swift|routing|\biban\b|upi|social\s?security|\bssn\b|\bsin\b|tax\s?id|\btin\b|driver'?s?\s?licen[cs]e|licen[cs]e\s?(number|no)|\bdl\s?no|passport|visa\s?number|voter\s?id|\bepic\b|token|secret|api\s?key|private\s?key|\bdob\b|date\s?of\s?birth|birth\s?date|mother'?s?\s?maiden|maiden\s?name|salary|income|net\s?worth|balance|medical|diagnos|prescription|health\s?(id|record))/i;

/** Input types that are sensitive by their nature, whatever they contain. */
const SENSITIVE_TYPE = new Set(['password', 'tel']);

/** autocomplete tokens the spec reserves for sensitive data. */
const SENSITIVE_AUTOCOMPLETE =
  /(cc-|current-password|new-password|one-time-code|bday|tel-national)/i;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

export function isSensitive(el: PageElement): boolean {
  // Identity first: a field is sensitive because of what it is, not only
  // what it currently holds. An empty card-number input still counts.
  if (el.input_type && SENSITIVE_TYPE.has(el.input_type)) return true;
  if (SENSITIVE_NAME.test(el.name ?? '')) return true;
  if (SENSITIVE_AUTOCOMPLETE.test(el.autocomplete ?? '')) return true;
  const v = el.value ?? '';
  if (!v) return false;
  if (PAN.test(v) || AADHAAR.test(v) || IFSC.test(v) || UPI.test(v)) return true;
  if (CARD.test(v) && luhnValid(v.replace(/\D/g, ''))) return true;
  return false;
}

/**
 * References are stable for a given field within a document, and rotate when
 * the document does.
 *
 * They were request-scoped and regenerated on every observation, but the agent
 * re-observes before each action — so a plan built against observation N
 * carried refs that no longer existed by the time it executed. A ref that
 * changes under the planner's feet buys nothing: the security property lives
 * in the executor's gate, not in the identifier churning.
 *
 * Refs remain opaque and unguessable. They are not predictable strings like
 * PASSWORD_1, so attacker-controlled page text cannot collide with them, and
 * they carry no meaning outside this document.
 */
const refsByElement = new Map<string, string>();
let refSalt = Math.random().toString(36).slice(2, 8);

/** Called when the document changes; invalidates every outstanding ref. */
export function rotateRefs(): void {
  refsByElement.clear();
  refSalt = Math.random().toString(36).slice(2, 8);
}

function newRef(elementId: string): string {
  const existing = refsByElement.get(elementId);
  if (existing) return existing;
  const ref = `ref_${refSalt}${Math.random().toString(36).slice(2, 6)}`;
  refsByElement.set(elementId, ref);
  return ref;
}

/**
 * What the vision pass found. Absent when no capture was taken, which is a
 * different thing from a capture that found nothing: the counts below stay at
 * zero either way, but `reOcrVerified` is only ever true when an image was
 * actually verified clean and sent.
 */
export interface VisualCounts {
  faces: number;
  ocrRegions: number;
  maskedRegions: number;
  reOcrVerified: boolean;
  canariesPlanted?: number;
  canariesEscaped?: number;
}

export interface Redacted {
  /** Safe to send. Contains no resolved values. */
  elements: SceneElement[];
  /** Local only. Never leaves this module's caller. */
  refMap: Map<string, { elementId: string; value: string }>;
  detection: DetectionCounts;
  redaction: RedactionCounts;
  fields: RedactedField[];
}

export function redactPageIR(ir: PageIR, visual?: VisualCounts): Redacted {
  const refMap = new Map<string, { elementId: string; value: string }>();
  let structuredPii = 0;

  const idByRef = new Map<string, string>();

  const elements: SceneElement[] = ir.elements.map((el) => {
    const sensitive = isSensitive(el);
    let ref = el.id;
    if (sensitive) {
      structuredPii += 1;
      ref = newRef(el.id);
      refMap.set(ref, { elementId: el.id, value: el.value ?? '' });
    }
    idByRef.set(ref, el.id);
    return {
      ref,
      role: el.role,
      name: el.name,
      input_type: el.input_type ?? null,
      sensitive,
      bbox: el.bbox ?? null,
    };
  });

  const fields: RedactedField[] = elements
    .filter((e) => e.sensitive || e.role === 'textbox' || e.role === 'button')
    .slice(0, 14)
    .map((e) => ({
      ref: e.ref,
      label: e.name || e.role,
      role: e.role,
      sensitive: e.sensitive,
      elementId: idByRef.get(e.ref) ?? e.ref,
    }));

  return {
    elements,
    refMap,
    fields,
    detection: {
      structuredPii,
      // Named-entity recognition is not implemented, so this stays at zero
      // rather than being filled with a plausible-looking number. A count we
      // did not measure is worse than an honest zero: it is the sort of thing
      // that survives into a slide and then into a question we cannot answer.
      namedEntities: 0,
      faces: visual?.faces ?? 0,
      ocrRegions: visual?.ocrRegions ?? 0,
    },
    redaction: {
      textReferences: refMap.size,
      maskedRegions: visual?.maskedRegions ?? 0,
      // False unless an image was redacted, read back, and found clean. No
      // capture at all is not verification.
      reOcrVerified: visual?.reOcrVerified ?? false,
      canariesPlanted: visual?.canariesPlanted ?? 0,
      canariesEscaped: visual?.canariesEscaped ?? 0,
    },
  };
}

/**
 * The exact body sent as `page_ir`. Nothing outside this shape reaches the
 * network — callers must not spread the raw PageIR alongside it.
 */
export interface OutboundPageIR {
  url: string;
  title: string;
  elements: SceneElement[];
  text_snippets: string[];
  observed_at: string;
  /**
   * The redacted screenshot, present only when re-OCR verification passed.
   *
   * Optional rather than nullable on purpose: an absent key is the default,
   * and every path that would have set it must first hold a verified image.
   */
  screenshot_b64?: string;
}

/**
 * Drops query parameters whose key or value looks sensitive, and the fragment
 * outright. A URL is metadata the planner needs for context, but query strings
 * are a routine carrier for session tokens, emails and account numbers.
 */
function sanitiseUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw.split(/[?#]/)[0]; }
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    const value = u.searchParams.get(key) ?? '';
    if (SENSITIVE_NAME.test(key) || isPII(value)) u.searchParams.set(key, '[redacted]');
  }
  return u.toString();
}

/**
 * Builds the outbound payload and asserts no sensitive value survives.
 *
 * The assertion covers the whole serialised body rather than the elements
 * array alone: url, title and snippets are as capable of carrying a protected
 * value as a field is, and this is the last point at which we can still refuse
 * to send one.
 */
export function buildOutbound(
  r: Redacted,
  ir: PageIR,
  visual?: { screenshotB64: string | null; reOcrVerified: boolean },
): { payload: OutboundPageIR; summary: OutboundSummary } {
  const payload: OutboundPageIR = {
    url: sanitiseUrl(ir.url),
    title: redactSnippets([ir.title])[0] ?? '',
    elements: r.elements,
    text_snippets: redactSnippets(ir.text_snippets ?? []),
    observed_at: ir.observed_at,
  };

  // The single gate on pixels leaving the device. Both conditions, not
  // either: an image with no verification and a verification with no image
  // are each a bug, and neither may send anything.
  if (visual?.reOcrVerified && visual.screenshotB64) {
    payload.screenshot_b64 = visual.screenshotB64;
  }

  const serialised = JSON.stringify(payload);
  for (const { value } of r.refMap.values()) {
    if (value && serialised.includes(value)) {
      throw new Error('Redaction failed: a protected value reached the outbound payload.');
    }
  }
  return {
    payload,
    summary: {
      // Raw pixels, specifically. A verified-clean redacted image is not raw,
      // and this counter has only ever meant "unredacted".
      rawPixelsSent: 0,
      piiValuesSent: 0,
      fieldsDescribed: r.elements.length,
      preview: JSON.stringify(payload.elements.slice(0, 6), null, 2),
    },
  };
}
