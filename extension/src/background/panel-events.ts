import type {
  AgentEventBody, AgentEventMessage, AgentPhase, DetectionCounts, RedactionCounts,
  OutboundSummary, RedactedField, GrantRequest, ManifestLine,
} from '../shared/agent-events';

/**
 * Popups unmount on blur, so the worker holds the last known state and
 * replays it when a popup reconnects. The worker is the source of truth;
 * the UI is a view onto it.
 */
const snapshot: AgentEventMessage[] = [];

/**
 * Monotonic for the worker's lifetime — deliberately not reset with the
 * snapshot. A panel dedupes on this, and a counter that restarted could
 * collide with an id the panel had already seen and silently swallow a real
 * event.
 */
let seq = 0;

/** Events that supersede an earlier one of the same type. */
const REPLACES = new Set([
  'AGENT_PHASE', 'AGENT_PAGE', 'AGENT_DETECTION',
  'AGENT_REDACTION', 'AGENT_OUTBOUND', 'AGENT_CONFIRM_REQUIRED', 'AGENT_MANIFEST',
]);

function remember(message: AgentEventMessage) {
  if (REPLACES.has(message.type)) {
    const i = snapshot.findIndex((m) => m.type === message.type);
    if (i !== -1) snapshot.splice(i, 1);
  }
  if (message.type === 'AGENT_ACTION_RESOLVED') {
    // a resolution clears any pending confirmation
    const i = snapshot.findIndex((m) => m.type === 'AGENT_CONFIRM_REQUIRED');
    if (i !== -1) snapshot.splice(i, 1);
  }
  snapshot.push(message);
}

function emit(body: AgentEventBody) {
  // Stamped once, here. A replayed event then reports when it happened
  // rather than when it was replayed.
  const message: AgentEventMessage = { ...body, at: new Date().toISOString(), seq: ++seq };
  remember(message);
  chrome.runtime.sendMessage(message).catch(() => {});
}

/** Replayed in order when a popup sends PANEL_READY. */
export function replaySnapshot() {
  for (const m of snapshot) {
    chrome.runtime.sendMessage({ ...m, replay: true }).catch(() => {});
  }
}

export function clearSnapshot() {
  snapshot.length = 0;
}

export const emitPhase = (phase: AgentPhase) => emit({ type: 'AGENT_PHASE', phase });

/** One observation pass: how much was described, and how much was sealed. */
export const emitObserved = (elements: number, sensitive: number) =>
  emit({ type: 'AGENT_OBSERVED', elements, sensitive });
export const emitError = (message: string) => emit({ type: 'AGENT_ERROR', message });
export const emitDetection = (counts: DetectionCounts) => emit({ type: 'AGENT_DETECTION', counts });
export const emitRedaction = (counts: RedactionCounts, fields: RedactedField[]) =>
  emit({ type: 'AGENT_REDACTION', counts, fields });
export const emitOutbound = (summary: OutboundSummary) => emit({ type: 'AGENT_OUTBOUND', summary });
export const emitConfirmRequired = (request: GrantRequest) =>
  emit({ type: 'AGENT_CONFIRM_REQUIRED', request });
export const emitActionResolved = (
  effect: string,
  outcome: 'executed' | 'refused',
  reason?: string,
) => emit({ type: 'AGENT_ACTION_RESOLVED', effect, outcome, reason });

export const emitManifest = (entries: ManifestLine[]) =>
  emit({ type: 'AGENT_MANIFEST', entries });

export async function emitActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  let origin = tab.url;
  try { origin = new URL(tab.url).origin; } catch { /* keep raw */ }
  emit({ type: 'AGENT_PAGE', origin, title: tab.title ?? 'Untitled' });
}
