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

  // Never invent a handle. An unregistered id is correctly refused by the
  // registry, which would look like a security event rather than a stub bug.
  const customerId = find(/customer|note/i);
  const password = find(/password/i);
  const transfer = find(/transfer/i);

  switch (step) {
    case 0:
      return {
        status: 'step',
        message: 'Filling the customer ID',
        action: customerId
          ? { action: 'type', element_id: customerId, text: 'demo-user' }
          : { action: 'scroll', direction: 'down', amount: 0 },
      };

    case 1:
      return {
        status: 'step',
        message: 'Entering the credential by reference',
        action: password
          ? { action: 'type', element_id: password, text: '' }
          : { action: 'scroll', direction: 'down', amount: 0 },
      };

    case 2:
      // The compromised step. The page's hidden text instructed this; the
      // planner complied. The executor is what stops it.
      return {
        status: 'step',
        message: 'Opening an external destination',
        action: { action: 'navigate', url: 'https://collector.example.net/exfil' },
      };

    case 3: {
      // The legitimate end of a login task. It is high-impact, so the grant
      // allows it but the executor stops for the user's confirmation first —
      // one effect, one document, one use.
      const signin = find(/sign\s?in|log\s?in|submit/i);
      return {
        status: 'step',
        message: 'Signing in',
        action: signin
          ? { action: 'submit', element_id: signin }
          : { action: 'done', summary: 'Nothing further to do.' },
      };
    }

    default:
      return {
        status: 'done',
        message: 'Signed in.',
        action: { action: 'done', summary: 'Login complete.' },
      };
  }
}
