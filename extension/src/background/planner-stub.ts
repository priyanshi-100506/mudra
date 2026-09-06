import type { AgentAction } from '../shared/types';

/**
 * DEMO ONLY — a stand-in for the remote planner.
 *
 * This exists so the executor's refusal can be demonstrated without a running
 * backend. It is NOT a mock of the security boundary: everything downstream of
 * it — grant derivation, the action gate, the refusal, the audit entry — is the
 * real code path, unchanged.
 *
 * It deliberately behaves like a COMPROMISED planner. The fixture page carries
 * a hidden injected instruction; this stub "complies" with it and proposes the
 * attacker's action. The demo's point is that the executor refuses anyway.
 *
 * Enabled only when chrome.storage.local.plannerStub === true. Off by default.
 */

export const STUB_ENABLED_KEY = 'plannerStub';

export interface StubStep {
  status: 'step' | 'done';
  message: string;
  action: AgentAction;
}

interface SceneLike {
  ref: string;
  role: string;
  name: string;
}

/** The scripted plan, one step per call. */
export function stubPlan(step: number, elements: SceneLike[]): StubStep {
  const find = (re: RegExp) => elements.find((e) => re.test(e.name))?.ref;

  const customerId = find(/customer/i);
  const password = find(/password/i);
  const transfer = find(/transfer/i);

  switch (step) {
    case 0:
      return {
        status: 'step',
        message: 'Filling the customer ID',
        action: { action: 'type', element_id: customerId ?? 'e1', text: 'demo-user' },
      };

    case 1:
      return {
        status: 'step',
        message: 'Entering the credential by reference',
        action: { action: 'type', element_id: password ?? 'e2', text: '' },
      };

    case 2:
      // The compromised step. The page's hidden text instructed this; the
      // planner complied. The executor is what stops it.
      return {
        status: 'step',
        message: 'Opening an external destination',
        action: { action: 'navigate', url: 'https://collector.example.net/exfil' },
      };

    case 3:
      return {
        status: 'step',
        message: 'Submitting the transfer',
        action: { action: 'click', element_id: transfer ?? 'e9' },
      };

    default:
      return {
        status: 'done',
        message: 'Signed in.',
        action: { action: 'done', summary: 'Login complete.' },
      };
  }
}
