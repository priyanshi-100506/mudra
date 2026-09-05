import { isAgentEvent, sendPanelCommand } from '../src/shared/messaging';
import type { AgentEventMessage } from '../src/shared/agent-events';
import type { AgentEvent } from './state';

/** Maps a worker event onto a reducer event. Returns null for anything unknown. */
export function toAgentEvent(msg: AgentEventMessage): AgentEvent | null {
  switch (msg.type) {
    case 'AGENT_PHASE':
      return { type: 'PHASE', phase: msg.phase };
    case 'AGENT_PAGE':
      return { type: 'PAGE', page: { origin: msg.origin, title: msg.title } };
    case 'AGENT_DETECTION':
      return { type: 'DETECTION', detection: msg.counts };
    case 'AGENT_REDACTION':
      return { type: 'REDACTION', redaction: msg.counts, fields: msg.fields };
    case 'AGENT_OUTBOUND':
      return { type: 'OUTBOUND', outbound: msg.summary };
    case 'AGENT_CONFIRM_REQUIRED':
      return { type: 'CONFIRM_REQUIRED', pending: msg.request };
    case 'AGENT_ACTION_RESOLVED':
      return {
        type: 'CONFIRM_RESOLVED',
        entry: {
          at: new Date().toISOString(),
          effect: msg.effect,
          outcome: msg.outcome,
          reason: msg.reason,
        },
      };
    case 'AGENT_ERROR':
      return { type: 'ERROR', message: msg.message };
    default:
      return null;
  }
}

export function subscribe(dispatch: (e: AgentEvent) => void): () => void {
  const listener = (raw: unknown) => {
    if (!isAgentEvent(raw)) return;
    const event = toAgentEvent(raw);
    if (event) dispatch(event);
  };
  chrome.runtime.onMessage.addListener(listener);
  void sendPanelCommand({ type: 'PANEL_READY' });
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function startTask(goal: string): Promise<unknown> {
  return chrome.runtime.sendMessage({ type: 'START_TASK', goal });
}

export function sendDecision(decision: 'authorise' | 'refuse'): Promise<unknown> {
  return sendPanelCommand({ type: 'PANEL_CONFIRM', decision });
}
