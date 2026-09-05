import type { AgentEventMessage, AgentPhase, DetectionCounts, RedactionCounts, OutboundSummary, RedactedField } from '../shared/agent-events';

function emit(message: AgentEventMessage) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

export const emitPhase = (phase: AgentPhase) => emit({ type: 'AGENT_PHASE', phase });
export const emitError = (message: string) => emit({ type: 'AGENT_ERROR', message });
export const emitDetection = (counts: DetectionCounts) => emit({ type: 'AGENT_DETECTION', counts });
export const emitRedaction = (counts: RedactionCounts, fields: RedactedField[]) =>
  emit({ type: 'AGENT_REDACTION', counts, fields });
export const emitOutbound = (summary: OutboundSummary) => emit({ type: 'AGENT_OUTBOUND', summary });

export async function emitActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  let origin = tab.url;
  try { origin = new URL(tab.url).origin; } catch { /* keep raw */ }
  emit({ type: 'AGENT_PAGE', origin, title: tab.title ?? 'Untitled' });
}
