import { AgentAction, ExecutionResult } from '../shared/types';
import { resolve as resolveHandle } from './node-registry';

export class HandleRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(detail);
    this.name = 'HandleRefusedError';
    this.reason = reason;
  }
}

/**
 * Resolves an opaque handle to a live node and revalidates it immediately
 * before use — identity, epoch, connectedness, origin and role must all still
 * match what was observed.
 *
 * This is the time-of-check-to-time-of-use defence. A page can rebind what a
 * selector points to between the moment the plan was made and the moment we
 * act; it cannot rebind node identity. Never cache this result: the whole
 * point is that it is checked at the last possible moment.
 */
function getLiveElement(id: string, expectedRole?: string): Element {
  const r = resolveHandle(id, expectedRole);
  if (!r.ok) {
    throw new HandleRefusedError(r.reason, r.detail);
  }
  return r.el;
}

/**
 * Safely executes a single AgentAction on the DOM.
 */
export async function executeAction(action: AgentAction): Promise<ExecutionResult> {
  try {
    switch (action.action) {
      case 'click': {
        const el = getLiveElement(action.element_id);
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        (el as HTMLElement).click();
        return { success: true };
      }

      case 'type': {
        const el = getLiveElement(action.element_id, 'textbox') as HTMLInputElement | HTMLTextAreaElement;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        el.focus();
        el.value = action.text;

        // Dispatch synthetic events so framework-bound inputs (React/Vue/Angular) register the change
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }

      case 'select': {
        const el = getLiveElement(action.element_id, 'select') as HTMLSelectElement;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        el.value = action.option;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }

      case 'scroll': {
        const delta = action.direction === 'down' ? action.amount : -action.amount;
        window.scrollBy({ top: delta, behavior: 'smooth' });
        return { success: true };
      }

      case 'navigate': {
        window.location.href = action.url;
        return { success: true };
      }

      case 'wait': {
        await new Promise((resolve) => setTimeout(resolve, action.duration_ms));
        return { success: true };
      }

      case 'extract': {
        const el = getLiveElement(action.element_id);
        const text = el.textContent?.trim() || (el as HTMLInputElement).value || '';
        return { success: true, extracted_data: text };
      }

      case 'done': {
        return { success: true };
      }

      default:
        return { success: false, error: 'Unknown action type' };
    }
  } catch (err: any) {
    if (err instanceof HandleRefusedError) {
      return {
        success: false,
        error: `Refused (${err.reason}): ${err.message}`,
      };
    }
    return {
      success: false,
      error: err.message || 'Execution failed',
    };
  }
}