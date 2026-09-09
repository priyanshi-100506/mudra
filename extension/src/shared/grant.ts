import type { AgentAction } from './types';

/** A local, task- and document-scoped authorisation. Never minted by the server. */
export interface Grant {
  task: string;
  origin: string;
  allowedEffects: string[];
  maxUses: number;
  usesRemaining: number;
  /**
   * Set once, by the user, before the page is ever observed. Until it is true
   * nothing high-impact runs — an unauthorised grant refuses rather than
   * prompting, so a task that skipped the dialog cannot quietly proceed.
   */
  authorised: boolean;
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
             maxUses: 1, usesRemaining: 1, authorised: false };
  }
  if (t.includes('fill') || t.includes('form') || t.includes('apply')) {
    return { task: 'form_fill', origin, allowedEffects: [...base, 'submit_form'],
             maxUses: 1, usesRemaining: 1, authorised: false };
  }
  return { task: 'read_only', origin, allowedEffects: base, maxUses: 0, usesRemaining: 0,
           authorised: false };
}

export type Verdict =
  | { kind: 'allow'; effect: string; consumesUse: boolean }
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
    // The user authorised this task, on this origin, before anything was
    // observed — and saw which effects that covered. What is checked here is
    // that the authorisation exists and has not been spent.
    if (!grant.authorised) {
      return { kind: 'refuse', effect, reason: 'This task has not been authorised.' };
    }
    if (grant.usesRemaining <= 0) {
      return { kind: 'refuse', effect, reason: 'This authorisation has already been used.' };
    }
    return { kind: 'allow', effect, consumesUse: true };
  }
  return { kind: 'allow', effect, consumesUse: false };
}

/** The one question the user is asked, before the page is read. */
export function taskSentence(grant: Grant): string {
  const host = grant.origin.replace(/^https?:\/\//, '') || 'this page';
  switch (grant.task) {
    case 'login':     return `Let Mudra sign you in on ${host}?`;
    case 'form_fill': return `Let Mudra fill and submit this form on ${host}?`;
    default:          return `Let Mudra read ${host} to do this?`;
  }
}

/** Plain-language summary of what the grant permits, for the dialog. */
export function grantSummary(grant: Grant): string[] {
  const lines = ['Read the visible fields on this page'];
  if (grant.allowedEffects.includes('set_public_text')) lines.push('Type into ordinary fields');
  if (grant.allowedEffects.includes('set_secret')) lines.push('Enter a saved credential by reference');
  if (grant.allowedEffects.includes('submit_form')) {
    lines.push(grant.maxUses === 1 ? 'Submit the form once' : 'Submit the form');
  }
  lines.push('Sensitive values stay on this device');
  return lines;
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
