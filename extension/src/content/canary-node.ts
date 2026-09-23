/**
 * Plants canary tokens in the page the agent is about to observe.
 *
 * This is the part that makes canaries mean anything. A tracer injected into
 * the payload after redaction has run travels a path no real value takes, so
 * its survival or absence says nothing about whether a real Aadhaar number
 * would have survived. To be evidence, a canary has to enter where real PII
 * enters: as text in the DOM, read by `capturePageIR`, classified by the same
 * `isPII`, sealed into a ref by the same redactor.
 *
 * The node is removed immediately after the observation. It is inert while it
 * exists — aria-hidden, off-screen, not focusable, no layout effect — because
 * the page belongs to the user and we are borrowing it for one frame.
 */
import type { Canary } from '../shared/canary';

const NODE_ID = '__mudra_canary__';

/**
 * Inserts the canary node and returns a function that removes it.
 *
 * Returning the remover rather than exposing a `remove()` makes it awkward to
 * plant without arranging to clean up, which is the failure mode that would
 * leave fake identifiers sitting in someone's DOM.
 */
export function plantCanaries(canaries: Canary[], doc: Document = document): () => void {
  removeCanaries(doc);
  const node = doc.createElement('div');
  node.id = NODE_ID;
  node.setAttribute('aria-hidden', 'true');
  // Off-screen rather than display:none: a displayed node is what the
  // perception layer actually walks, and hiding it outright would route the
  // canary around the visibility checks real values pass through.
  node.style.cssText =
    'position:absolute;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;';
  node.textContent = canaries.map((c) => `${c.kind}: ${c.value}`).join(' ');
  (doc.body ?? doc.documentElement).appendChild(node);
  return () => removeCanaries(doc);
}

export function removeCanaries(doc: Document = document): void {
  doc.getElementById(NODE_ID)?.remove();
}

/** True when the node is present — used by tests to assert cleanup happened. */
export function canaryNodePresent(doc: Document = document): boolean {
  return doc.getElementById(NODE_ID) !== null;
}
