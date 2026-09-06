import type { AgentAction } from './types';

/** A local, task- and document-scoped authorisation. Never minted by the server. */
export interface Grant {
  task: string;
  origin: string;
  allowedEffects: string[];
  maxUses: number;
  usesRemaining: number;
}

/** Effects that require the user to confirm before they run. */
const HIGH_IMPACT = new Set([
  'submit_form', 'navigate_cross_origin', 'transfer', 'purchase',
  'delete', 'upload', 'set_secret',
]);

/** Maps a planner action onto the effect name a grant talks about. */
export function effectOf(action: AgentAction): string {
  switch (action.action) {
    case 'click':    return 'click';
    case 'type':     return 'set_public_text';
    case 'select':   return 'select';
    case 'scroll':   return 'scroll';
    case 'extract':  return 'extract';
    case 'wait':     return 'wait';
    case 'submit':   return 'submit_form';
    case 'navigate': return 'navigate_cross_origin';
    case 'done':     return 'done';
    default:         return 'unknown';
  }
}

export const isHighImpact = (effect: string) => HIGH_IMPACT.has(effect);

/** Derived locally at task start from a small set of templates. */
export function deriveGrant(task: string, origin: string): Grant {
  const t = task.toLowerCase();
  const base = ['click', 'set_public_text', 'select', 'scroll', 'wait', 'extract', 'done'];

  if (t.includes('log') || t.includes('sign in')) {
    return { task: 'login', origin, allowedEffects: [...base, 'set_secret', 'submit_form'],
             maxUses: 1, usesRemaining: 1 };
  }
  if (t.includes('fill') || t.includes('form') || t.includes('apply')) {
    return { task: 'form_fill', origin, allowedEffects: [...base, 'submit_form'],
             maxUses: 1, usesRemaining: 1 };
  }
  return { task: 'read_only', origin, allowedEffects: base, maxUses: 0, usesRemaining: 0 };
}

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'confirm'; effect: string }
  | { kind: 'refuse'; effect: string; reason: string };

/**
 * The gate. Every side-effecting action passes through here before execution.
 * Fail closed: anything unmatched is refused.
 */
export function checkAction(
  action: AgentAction,
  grant: Grant | null,
  currentOrigin: string,
): Verdict {
  const effect = effectOf(action);

  if (!grant) {
    return { kind: 'refuse', effect, reason: 'No grant is active for this task.' };
  }
  if (grant.origin !== currentOrigin) {
    return { kind: 'refuse', effect,
             reason: `Grant was issued for ${grant.origin}, page is now ${currentOrigin}.` };
  }
  if (!grant.allowedEffects.includes(effect)) {
    return { kind: 'refuse', effect,
             reason: `"${effect}" is not among the effects authorised for this task.` };
  }
  if (isHighImpact(effect)) {
    if (grant.usesRemaining <= 0) {
      return { kind: 'refuse', effect, reason: 'This authorisation has already been used.' };
    }
    return { kind: 'confirm', effect };
  }
  return { kind: 'allow' };
}

/** One plain sentence a non-technical reader parses in three seconds. */
export function confirmSentence(effect: string, origin: string): string {
  const host = origin.replace(/^https?:\/\//, '');
  switch (effect) {
    case 'submit_form':            return `Submit this form on ${host}?`;
    case 'set_secret':             return `Enter your saved credential on ${host}?`;
    case 'navigate_cross_origin':  return `Leave ${host} and open another site?`;
    case 'upload':                 return `Upload a file to ${host}?`;
    default:                       return `Allow "${effect}" on ${host}?`;
  }
}
