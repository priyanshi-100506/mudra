import type { PageIR, PageElement } from './types';
import type { SceneElement, DetectionCounts, RedactionCounts, OutboundSummary, RedactedField } from './agent-events';

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

let counter = 0;
const newRef = () => `ref_${(++counter).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export interface Redacted {
  /** Safe to send. Contains no resolved values. */
  elements: SceneElement[];
  /** Local only. Never leaves this module's caller. */
  refMap: Map<string, { elementId: string; value: string }>;
  detection: DetectionCounts;
  redaction: RedactionCounts;
  fields: RedactedField[];
}

export function redactPageIR(ir: PageIR): Redacted {
  const refMap = new Map<string, { elementId: string; value: string }>();
  let structuredPii = 0;

  const idByRef = new Map<string, string>();

  const elements: SceneElement[] = ir.elements.map((el) => {
    const sensitive = isSensitive(el);
    let ref = el.id;
    if (sensitive) {
      structuredPii += 1;
      ref = newRef();
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
    detection: { structuredPii, faces: 0, namedEntities: 0, ocrRegions: 0 },
    redaction: { textReferences: refMap.size, maskedRegions: 0, reOcrVerified: false },
  };
}

/** Builds the outbound payload. Asserts no sensitive value survives. */
export function buildOutbound(r: Redacted): { payload: { elements: SceneElement[] }; summary: OutboundSummary } {
  const payload: { elements: SceneElement[] } = { elements: r.elements };
  const serialised = JSON.stringify(payload);
  for (const { value } of r.refMap.values()) {
    if (value && serialised.includes(value)) {
      throw new Error('Redaction failed: a protected value reached the outbound payload.');
    }
  }
  return {
    payload,
    summary: {
      rawPixelsSent: 0,
      piiValuesSent: 0,
      fieldsDescribed: r.elements.length,
      preview: JSON.stringify(payload.elements.slice(0, 6), null, 2),
    },
  };
}
