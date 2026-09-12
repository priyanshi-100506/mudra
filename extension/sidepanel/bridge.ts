import { isAgentEvent, sendPanelCommand } from '../src/shared/messaging';
import type { AgentEventMessage } from '../src/shared/agent-events';
import type { AgentEvent } from './state';

/**
 * Maps a worker event onto a reducer event. Returns null for anything unknown.
 *
 * The envelope (`at`, `seq`, `replay`) rides along on every one of them: the
 * reducer needs `seq` to dedupe a replay and `at` to timestamp a feed row
 * with when it actually happened.
 */
export function toAgentEvent(msg: AgentEventMessage): AgentEvent | null {
  const meta = { at: msg.at, seq: msg.seq, replay: msg.replay };
  switch (msg.type) {
    case 'AGENT_PHASE':
      return { type: 'PHASE', phase: msg.phase, meta };
    case 'AGENT_OBSERVED':
      return { type: 'OBSERVED', elements: msg.elements, sensitive: msg.sensitive, meta };
    case 'AGENT_PAGE':
      return { type: 'PAGE', page: { origin: msg.origin, title: msg.title }, meta };
    case 'AGENT_DETECTION':
      return { type: 'DETECTION', detection: msg.counts, meta };
    case 'AGENT_REDACTION':
      return { type: 'REDACTION', redaction: msg.counts, fields: msg.fields, meta };
    case 'AGENT_OUTBOUND':
      return { type: 'OUTBOUND', outbound: msg.summary, meta };
    case 'AGENT_CONFIRM_REQUIRED':
      return { type: 'CONFIRM_REQUIRED', pending: msg.request, meta };
    case 'AGENT_ACTION_RESOLVED':
      return {
        type: 'ACTION_RESOLVED',
        meta,
        entry: {
          // The worker's stamp, not the panel's clock — a replayed action
          // must still report when it actually ran.
          at: msg.at ?? new Date().toISOString(),
          effect: msg.effect,
          outcome: msg.outcome,
          reason: msg.reason,
        },
      };
    case 'AGENT_MANIFEST':
      return { type: 'MANIFEST', entries: msg.entries, meta };
    case 'AGENT_ERROR':
      return { type: 'ERROR', message: msg.message, meta };
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

/** Tears the run down in the worker, not just in this view. */
export function stopTask(): Promise<unknown> {
  return chrome.runtime.sendMessage({ type: 'STOP_TASK' });
}
