import type { PageIR, PageElement } from './types';
import type { SceneElement, DetectionCounts, RedactionCounts, OutboundSummary, RedactedField } from './agent-events';

const PAN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;
const AADHAAR = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
const CARD = /\b\d{13,19}\b/;
const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/;
const UPI = /\b[\w.\-]{2,}@[a-zA-Z]{2,}\b/;
const SENSITIVE_NAME = /(pass|pwd|otp|cvv|pin|aadhaar|aadhar|pan\b|card|account|token|secret|ssn)/i;

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
  if (el.input_type === 'password') return true;
  if (SENSITIVE_NAME.test(el.name ?? '')) return true;
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

  const elements: SceneElement[] = ir.elements.map((el) => {
    const sensitive = isSensitive(el);
    let ref = el.id;
    if (sensitive) {
      structuredPii += 1;
      ref = newRef();
      refMap.set(ref, { elementId: el.id, value: el.value ?? '' });
    }
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
    .slice(0, 8)
    .map((e) => ({ ref: e.ref, label: e.name || e.role, role: e.role, sensitive: e.sensitive }));

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
